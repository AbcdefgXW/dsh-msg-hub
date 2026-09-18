/**
 * bridge.js — dsh 会话桥核心
 *
 * 把 IM 渠道消息注入 dsh agent 会话，取回复回传。
 * 依赖 dsh 服务（agents / sessions / agentDefaultModel），由插件入口注入 ctx。
 *
 * 会话映射：channel+peerId → SessionId（ch-<channel>-<peerId>，/new 轮换后带 -N 后缀）→ resume（有持久化会话）或 create。
 * 同一人同一渠道 = 同一会话（记忆连续），/new 可重开；存留按常驻策略自动管理。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diagLog } from "./diag.js";
import { sessionEvents } from "./session-events.js";

/** agent 工作区根：可用 DSH_CHANNELS_CWD 覆盖（迁移工作区时设置）。 */
const WORKSPACE_CWD = process.env.DSH_CHANNELS_CWD?.trim() || "/workspace";

/** 插件根目录（跟随插件文件位置，随目录整体迁移）。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 渠道会话策略（用户可配）：keepAliveSessions{开关+最近 N 个常驻 N=1~5 默认3}；inheritRecentCount（/new 记忆继承条数 1~30 默认10）；sweepIntervalMinutes（自动释放间隔分钟 0~60 默认0=不自动） ──
const CFG_FILE = path.join(PLUGIN_ROOT, "state", "config.json");
let channelsCfg = { keepAliveSessions: { enabled: true, count: 3 }, inheritRecentCount: 10, sweepIntervalMinutes: 0 };

const clampInt = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), min), max) : fallback;
};

function loadCfg() {
  try {
    if (fs.existsSync(CFG_FILE)) {
      const j = JSON.parse(fs.readFileSync(CFG_FILE, "utf-8"));
      const ks = j?.keepAliveSessions;
      if (ks && typeof ks === "object") {
        channelsCfg = {
          keepAliveSessions: {
            enabled: ks.enabled === undefined ? true : !!ks.enabled,
            count: clampInt(ks.count, 1, 5, 3),
          },
          inheritRecentCount: clampInt(j?.inheritRecentCount, 1, 30, 10),
          sweepIntervalMinutes: clampInt(j?.sweepIntervalMinutes, 0, 60, 0),
        };
      }
    }
  } catch {}
}

// ── 自动释放定时器（模块级调度器：0=不自动；1~60=每 N 分钟自动跑一次 sweep） ──
let sweepFn = null;
let sweepTimer = null;
function rescheduleSweep() {
  const mins = clampInt(channelsCfg?.sweepIntervalMinutes, 0, 60, 0);
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (mins > 0 && typeof sweepFn === "function") {
    sweepTimer = setInterval(() => {
      try { sweepFn(); } catch {}
    }, mins * 60 * 1000);
  }
}
/** createBridge 把自己的 sweep 注册进自动调度（幂等；配置变化即重排定时器）。 */
export function registerSweep(fn) {
  sweepFn = fn;
  rescheduleSweep();
}

function saveCfg() {
  try {
    fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true });
    const tmp = CFG_FILE + ".tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(channelsCfg, null, 2), "utf-8");
    fs.renameSync(tmp, CFG_FILE);
  } catch {}
}

loadCfg();

/** 读取会话常驻策略（保持不变的对象引用，勿直接改字段）。 */
export function getChannelsCfg() {
  return channelsCfg;
}

/** 更新渠道会话策略：{ keepAliveSessions?: { enabled?, count? }, inheritRecentCount?, sweepIntervalMinutes? }，count 1~5，继承条数 1~30，自动释放间隔 0~60 分钟（0=不自动）。 */
export function setChannelsCfg(patch) {
  const ks = patch?.keepAliveSessions ?? {};
  const enabled = ks.enabled === undefined ? channelsCfg.keepAliveSessions.enabled : !!ks.enabled;
  const count = clampInt(ks.count ?? channelsCfg.keepAliveSessions.count, 1, 5, channelsCfg.keepAliveSessions.count);
  const inheritRecentCount = clampInt(patch?.inheritRecentCount ?? channelsCfg.inheritRecentCount, 1, 30, channelsCfg.inheritRecentCount);
  const sweepIntervalMinutes = clampInt(patch?.sweepIntervalMinutes ?? channelsCfg.sweepIntervalMinutes, 0, 60, channelsCfg.sweepIntervalMinutes);
  channelsCfg = { keepAliveSessions: { enabled, count }, inheritRecentCount, sweepIntervalMinutes };
  saveCfg();
  rescheduleSweep();
  return channelsCfg;
}

/** 诊断日志：统一由 diag.js 提供（内置大小轮转与每日日志清理）。 */

/**
 * 从会话事件流聚合最后一次 assistant 文本回复。
 * 事件经 sessionEvents() 兼容取（dsh 新版 Session 无 events 属性，用 snapshotEvents()）。
 * 参考 dsh-headless 的 summarize 实现。
 */
function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

export function createBridge(ctx) {
  // 每个 sessionId 一个串行队列，避免并发交错
  const queues = new Map();
  // 正在处理消息的会话（sweep 跳过，防止释放进行中的 turn）
  const runningIds = new Set();
  // 会话常驻登记表：sessionId -> { dispose, agent, lastActive }
  const disposers = new Map();
  // 渠道会话轮换（/new）采用「干净 ID」方案：会话 ID 永远 = ch-<channel>-<peerId>，
  // /new 时旧会话文件改名时间戳归档（session.YYYYMMDD-hhmmss.jsonl.zstd），新会话复用原 ID。
  // 待继承记忆表：sessionId -> 摘要文本（rotate 时采集写入，新会话首次 create 时注入并删除）
  const INHERIT_FILE = path.join(PLUGIN_ROOT, "state", "inherit-memory.json");
  const inheritMemory = new Map(Object.entries((() => {
    try { return fs.existsSync(INHERIT_FILE) ? (JSON.parse(fs.readFileSync(INHERIT_FILE, "utf-8")) || {}) : {}; } catch { return {}; }
  })()));
  const saveInherit = () => {
    try {
      fs.mkdirSync(path.dirname(INHERIT_FILE), { recursive: true });
      const tmp = INHERIT_FILE + ".tmp-" + Date.now();
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(inheritMemory), null, 2), "utf-8");
      fs.renameSync(tmp, INHERIT_FILE);
    } catch {}
  };

  // ── 会话文件路径（与 dsh-session-persistence-jsonl 一致的编码规则，复刻自 dsh-toolbox） ──
  const SESSIONS_ROOT = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, "sessions") : "/home/dsh/sessions";
  function projectKey(cwd) {
    if (!cwd) return "_no-cwd";
    let readable = "";
    let sepRun = false;
    for (let i = 0; i < cwd.length; i++) {
      const code = cwd.charCodeAt(i);
      const ch = String.fromCharCode(code);
      if (ch === "/" || ch === "\\" || ch === ":") {
        if (!sepRun) readable += "-";
        sepRun = true;
      } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
        readable += ch;
        sepRun = false;
      } else {
        readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
        sepRun = false;
      }
    }
    return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
  }
  function encodeSegment(id) {
    let out = "";
    for (const ch of String(id)) {
      const code = ch.charCodeAt(0);
      out += ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
    return out;
  }
  /** 会话文件目录（可能不存在返回 null）。 */
  function sessionDirFor(sessionId) {
    try {
      return path.join(SESSIONS_ROOT, projectKey(WORKSPACE_CWD), encodeSegment(sessionId));
    } catch {}
    return null;
  }

  /** 归档旧会话文件：session.jsonl.zstd → session.YYYYMMDD-hhmmss.jsonl.zstd；返回新文件名或 null。 */
  function archiveSessionFile(sessionId) {
    const dir = sessionDirFor(sessionId);
    if (!dir) return null;
    try {
      const file = path.join(dir, "session.jsonl.zstd");
      if (!fs.existsSync(file)) return null;
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const dest = path.join(dir, `session.${stamp}.jsonl.zstd`);
      fs.renameSync(file, dest);
      return path.basename(dest);
    } catch { return null; }
  }

  /** 渠道会话 ID：永远 ch-<channel>-<peerId>（/new 不改 ID，干净方案）。 */
  function sessionIdFor(channel, peerId) {
    return SessionId(`ch-${channel}-${peerId}`);
  }

  /** 从会话事件提取一条人话文本（user 消息或 assistant 文本块），无则 null。 */
  function eventText(ev) {
    let blocks = null;
    if (ev.type === "user/message") blocks = ev.data?.content;
    else if (ev.type === "assistant/message") blocks = ev.data?.message?.content;
    if (!Array.isArray(blocks)) return null;
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
    return text ? text : null;
  }

  /**
   * 采集旧会话最近对话文本（live 优先，磁盘经 sessionPersistence.load 读取），
   * 用于新会话的记忆继承。条数取配置 inheritRecentCount（默认 10）、截断 8000 字符；读不到返回 null。
   */
  async function collectRecentText(ctx, sessionId) {
    const MAX = clampInt(getChannelsCfg()?.inheritRecentCount, 1, 30, 10);
    const MAX_CHARS = 8000;
    let events = null;
    try {
      const live = ctx.get("agents")?.get?.(sessionId)?.session;
      if (live) events = sessionEvents(live);
      if (!events || events.length === 0) {
        const persist = ctx.get?.("sessionPersistence");
        if (persist && typeof persist.load === "function") {
          const loaded = await persist.load(sessionId);
          // load 可能返回 session 本体或 { session } 包装，两种都兼容
          const target = loaded?.session ?? loaded;
          events = sessionEvents(target);
        }
      }
    } catch {}
    if (!events || events.length === 0) return null;
    const picked = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const t = eventText(events[i]);
      if (t === null) continue;
      picked.push((events[i].type === "user/message" ? "我：" : "AI：") + t);
      if (picked.length >= MAX) break;
    }
    if (picked.length === 0) return null;
    picked.reverse();
    let body = picked.join("\n\n");
    if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + "\n…（过长截断）";
    return `【记忆继承】以下为上一段会话「${sessionId}」的最近对话（${picked.length} 条），接续时请以此为上下文；更早的完整记录在工作区工具箱可查：\n\n${body}`;
  }

  function withLock(sessionId, fn) {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const wrap = async () => {
      runningIds.add(sessionId);
      try {
        return await fn();
      } finally {
        runningIds.delete(sessionId);
      }
    };
    const next = prev.then(wrap, wrap);
    queues.set(sessionId, next.catch(() => {}));
    return next;
  }

  async function runTurn(sessionId, text) {
    const agents = ctx.get("agents");
    const sessions = ctx.get("sessions");
    const defaultModel = ctx.get("agentDefaultModel");
    if (!agents || !sessions || !defaultModel) {
      throw new Error("bridge: agents/sessions/agentDefaultModel 服务不可用");
    }

    const selection = defaultModel.currentSelection();
    const agentOptions = {
      provider: selection.provider,
      model: selection.model,
    };
    const meta = { cwd: WORKSPACE_CWD };

    // 挂载守一人设预设（persona + 工具集），与主会话一致
    const presets = ctx.get("agentPresets");
    let presetId;
    let presetSetup;
    if (presets) {
      try {
        const resolved = await presets.resolve(undefined); // 默认预设（settings: shouyi）
        presetId = resolved.id;
        presetSetup = async (agentCtx) => {
          diagLog(`setup 开始（agentCtx scope=${typeof agentCtx}）`);
          try {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 });
            diagLog("installModelSelection OK");
          } catch (imsErr) {
            diagLog(`installModelSelection 失败: ${String(imsErr)}`);
          }
          try {
            await presets.mount(agentCtx, presetId);
            diagLog(`mount 完成: ${presetId}`);
          } catch (mountErr) {
            diagLog(`mount 失败: ${String(mountErr)}`);
          }
        };
        diagLog(`使用预设: ${presetId}`);
      } catch (presetErr) {
        diagLog(`预设解析失败（跳过，使用默认）: ${String(presetErr)}`);
      }
    }
    const withPreset = (options) => ({
      ...options,
      ...(presetId ? { meta: { ...(options.meta ?? {}), agentPreset: presetId } } : {}),
      ...(presetSetup ? { setup: presetSetup } : {}),
    });

    // 诊断：记录 store 现状
    try {
      const liveSessions = sessions.list ? sessions.list().map((s) => s.id) : [];
      diagLog(`处理消息前 store 内会话: ${JSON.stringify(liveSessions)}`);
    } catch (diagErr) {
      console.error(`bridge: 诊断失败: ${String(diagErr)}`);
    }

    let handle;
    // 1) 已有 live agent（dsh 恢复/上次残留）→ 直接复用，避免 resume/create 撞"已存在"
    const liveAgent = agents.get(sessionId);
    if (liveAgent) {
      const livePreset = liveAgent.session?.header?.agentPreset;
      if (livePreset) {
        diagLog(`复用 live agent（预设=${livePreset}）: ${sessionId}`);
        handle = { agent: liveAgent, dispose: null };
      } else {
        // 无预设的白纸 agent：不复用（保持其存活，走 resume 会撞 live，这里只告警并继续复用）
        diagLog(`⚠️ live agent 无预设（${sessionId}），复用时可能缺少人设/工具`);
        handle = { agent: liveAgent, dispose: null };
      }
    } else {
      try {
        // 2) 优先恢复持久化会话（同一人同一渠道记忆连续）；withPreset 带 setup 挂载守一人设
        handle = await agents.resume(withPreset({
          resumeSessionId: sessionId,
          meta,
          agentOptions,
        }));
      } catch (resumeErr) {
        diagLog(`resume 失败: ${resumeErr instanceof Error ? (resumeErr.stack ?? resumeErr.message) : String(resumeErr)}`);
        // 3) 无持久化会话 → 新建
        try {
          handle = await agents.create(withPreset({
            sessionId,
            meta,
            agentOptions,
          }));
          // 记忆继承：/new 时已将旧会话摘要存入 inheritMemory，首次 create 注入 agent 系统提示
          // （不占消息记录、不触发 AI 回复；旧会话文件已时间戳归档可查）
          try {
            if (inheritMemory.has(sessionId)) {
              const memoryText = inheritMemory.get(sessionId);
              const sp = handle?.agent?.ctx?.get?.("systemPrompt");
              if (sp && typeof sp.section === "function") {
                sp.section({ name: "inherit:memory", order: 80, text: memoryText });
                inheritMemory.delete(sessionId);
                saveInherit();
                diagLog(`记忆继承注入 OK（${sessionId}）`);
              } else {
                diagLog(`记忆继承跳过：agent 无 systemPrompt 服务`);
              }
            }
          } catch (inheritErr) {
            diagLog(`记忆继承失败: ${inheritErr instanceof Error ? inheritErr.message : String(inheritErr)}`);
          }
        } catch (createErr) {
          diagLog(`create 失败: ${createErr instanceof Error ? (createErr.stack ?? createErr.message) : String(createErr)}`);
          throw new Error(
            `resume 失败: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}; ` +
            `create 失败: ${createErr instanceof Error ? createErr.message : String(createErr)}`,
          );
        }
      }
    }

    // handle = { agent, dispose }（dispose 由 agent-loop 的 publish 返回）
    const { agent, dispose } = handle;
    // 登记/刷新 dispose 句柄与活跃时间（复用 live 路径 dispose 为 null，沿用旧句柄）
    if (typeof dispose === "function") {
      disposers.set(sessionId, { dispose, agent, lastActive: Date.now() });
    } else if (disposers.has(sessionId)) {
      disposers.get(sessionId).lastActive = Date.now();
    }
    try {
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        }),
      );
      await agent.whenIdle();
      await sessions.flush(agent.session);
      // dsh 0.1.5-rc.2 起 Session 不再暴露 events 属性（改 snapshotEvents()），统一经 sessionEvents 兼容取
      return summarize(sessionEvents(agent.session, firstSeq), firstSeq);
    } finally {
      // 释放决策统一交给 sweep()：按常驻策略保留最近 N 个，超出/未启用即释放
      await sweep();
    }
  }

  /** 钳制常驻数量 0~5。 */
  const clampCount = (n) => Math.min(Math.max(Math.floor(Number(n)) || 0, 0), 5);

  /**
   * 常驻策略扫描：保留最近 keepOverride 个活跃会话（override 缺省用配置），
   * 其余空闲会话释放（flush → dispose 摘除 registry+store，下次消息自动 resume）。
   * 正在处理消息的会话跳过。
   * @returns {{kept: string[], released: string[]}}
   */
  async function sweep(keepOverride) {
    const cfg = getChannelsCfg();
    const keep = keepOverride === undefined
      ? (cfg.keepAliveSessions.enabled ? clampCount(cfg.keepAliveSessions.count) : 0)
      : clampCount(keepOverride);
    const sorted = [...disposers.entries()].sort((a, b) => b[1].lastActive - a[1].lastActive);
    const keepSet = new Set(sorted.slice(0, keep).map(([id]) => id));
    const released = [];
    for (const [id, rec] of sorted) {
      if (keepSet.has(id)) continue;
      if (runningIds.has(id)) continue; // 正在处理消息，这次不动
      try {
        if (rec.agent && typeof rec.agent.whenIdle === "function") await rec.agent.whenIdle();
      } catch {}
      try {
        const sessions = ctx.get("sessions");
        if (sessions && typeof sessions.flush === "function" && rec.agent) await sessions.flush(rec.agent.session);
        if (typeof rec.dispose === "function") await rec.dispose();
        released.push(id);
      } catch (e) {
        diagLog(`sweep 释放失败 ${id}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        disposers.delete(id);
      }
    }
    return { kept: [...keepSet], released };
  }

  /** 释放指定渠道会话（/release）：精确释放当前 peer 的常驻会话。 */
  async function releaseTarget(channel, peerId) {
    const id = sessionIdFor(channel, peerId);
    const rec = disposers.get(id);
    if (!rec || runningIds.has(id)) return { released: [] };
    try {
      const sessions = ctx.get("sessions");
      if (sessions && typeof sessions.flush === "function" && rec.agent) await sessions.flush(rec.agent.session);
      if (typeof rec.dispose === "function") await rec.dispose();
      return { released: [id] };
    } finally {
      disposers.delete(id);
    }
  }

  /** 轮换会话（/new 干净方案）：会话 ID 永远不变；旧会话释放 + 文件时间戳归档，记忆继承入新会话。 */
  async function rotate(channel, peerId) {
    const sessionId = sessionIdFor(channel, peerId);
    if (runningIds.has(sessionId)) {
      return { ok: false, error: "该会话正在处理消息，请稍后再试" };
    }
    // 1) 先采继承记忆（旧文件改名之前；live 优先，磁盘经 persistence.load 兜底）
    try {
      const memoryText = await collectRecentText(ctx, sessionId);
      if (memoryText) {
        inheritMemory.set(sessionId, memoryText);
        saveInherit();
      }
    } catch (inheritErr) {
      diagLog(`rotate 记忆采集失败: ${inheritErr instanceof Error ? inheritErr.message : String(inheritErr)}`);
    }
    // 2) 释放 live（flush + dispose）
    let released = [];
    try {
      released = (await releaseTarget(channel, peerId)).released || [];
    } catch (releaseErr) {
      diagLog(`rotate 释放失败: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`);
    }
    // 3) 归档旧会话文件：session.jsonl.zstd → session.YYYYMMDD-hhmmss.jsonl.zstd（未落盘则无文件）
    const archived = archiveSessionFile(sessionId);
    // 4) 官方归档标记：左侧隐藏（sessionIds 槽位保留，重启不显示"未分组"）
    try {
      const reg = ctx.get("workspaceRegistry");
      if (reg && typeof reg.requireState === "function" && typeof reg.setState === "function") {
        const st = reg.requireState();
        if (!(st.archivedSessionIds || []).includes(sessionId)) {
          await reg.setState({ ...st, archivedSessionIds: [...(st.archivedSessionIds || []), sessionId] });
        }
      }
    } catch (stateErr) {
      diagLog(`rotate 归档标记失败: ${stateErr instanceof Error ? stateErr.message : String(stateErr)}`);
    }
    return { ok: true, sessionId, released, archived };
  }

  /**
   * 处理一条渠道入站消息。
   * @param {object} opts
   * @param {string} opts.channel  渠道标识（weixin / qq / feishu）
   * @param {string} opts.peerId   用户标识（openid / user_id）
   * @param {string} opts.text     消息文本
   * @param {(reply: string) => Promise<void>} opts.reply 回传函数
   * @returns {Promise<{ok: boolean, error?: string}>}
   * 会话存留按常驻策略（state/config.json keepAliveSessions）自动管理：
   * 保留最近 N 个活跃会话，其余用完释放（下次消息自动 resume）。
   */
  async function inbound({ channel, peerId, text, reply }) {
    const sessionId = sessionIdFor(channel, peerId);
    return withLock(sessionId, async () => {
      try {
        const outcome = await runTurn(sessionId, text);
        if (outcome.reason?.kind === "error") {
          const errText = `处理出错：${outcome.reason.error?.message ?? "未知错误"}`;
          diagLog(`${errText}（sessionId=${sessionId}）`);
          await reply?.(errText).catch((e) => diagLog(`错误回传失败：${e instanceof Error ? e.message : String(e)}（sessionId=${sessionId}）`));
          return { ok: false, error: errText };
        }
        // 回复回传必须留痕：此前 .catch(()=>{}) 把发送失败完全吞掉，线上无法判断"没发"还是"发了没到"
        if (outcome.text) {
          try {
            await reply?.(outcome.text);
            diagLog(`回复回传成功（${outcome.text.length} 字，sessionId=${sessionId}）`);
          } catch (e) {
            diagLog(`❌ 回复回传失败：${e instanceof Error ? e.message : String(e)}（${outcome.text.length} 字，sessionId=${sessionId}）\n${e instanceof Error ? (e.stack ?? "") : ""}`);
          }
        } else {
          diagLog(`⚠️ 回复文本为空，未回传（sessionId=${sessionId}，reason=${JSON.stringify(outcome.reason ?? null)}）`);
        }
        return { ok: true };
      } catch (err) {
        const msg = `桥接处理失败：${err instanceof Error ? err.message : String(err)}`;
        // 必须落日志：此前的实现只回传用户、不记录，导致线上排查无据可查
        diagLog(`${msg}（sessionId=${sessionId}）\n${err instanceof Error ? (err.stack ?? "") : ""}`);
        await reply?.(msg).catch((e) => diagLog(`失败回传也失败：${e instanceof Error ? e.message : String(e)}（sessionId=${sessionId}）`));
        return { ok: false, error: msg };
      }
    });
  }

  // 自动释放调度（配置 sweepIntervalMinutes>0 时每 N 分钟跑一次 sweep；结果进诊断日志）
  registerSweep(() => {
    sweep().then((r) => {
      if (r.released.length > 0) diagLog(`自动释放完成：保留 ${r.kept.length} 个，释放 ${r.released.length} 个常驻会话`);
    }).catch((e) => {
      diagLog(`自动释放失败: ${e instanceof Error ? e.message : String(e)}`);
    });
  });

  return { inbound, runTurn, sweep, release: sweep, releaseTarget, rotate, sessionIdFor };
}
