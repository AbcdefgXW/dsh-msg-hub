/**
 * remote.js — 远程监控（dsh-msg-hub）
 *
 * 在手机上远程监控 dsh：
 * - turn 推送：绑定会话的 agent 开始/完成/出错时推送 IM 通知
 * - 审批远程批准：绑定会话的 approval 请求推送 IM（含工具名+原因+命令详情），
 *   用户回复「批准 / 拒绝」应答（带超时，超时按拒绝处理，fail-closed）
 * - 会话命令：/sessions 列出最近会话、/bind <sessionId> 绑定、/status 查看状态、
 *   /new（该渠道开新会话，旧会话释放历史保留）、/release（释放本渠道常驻会话）、
 *   /cfg（查看/设置会话常驻策略：/cfg keepalive on|off [1-5]）
 *
 * 绑定关系持久化在 state/remote-bindings.json。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionEvents } from "./session-events.js";

const STATE_DIR = process.env.DSH_CHANNELS_STATE_DIR?.trim() ||
  path.join(fileURLToPath(new URL("../", import.meta.url)), "state");
const BINDINGS_FILE = path.join(STATE_DIR, "remote-bindings.json");

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 审批等待用户回复超时（5 分钟，fail-closed）

/** 持久化绑定表：{ sessionId: [{ channel, peerId, boundAt }] } */
function loadBindings() {
  try {
    if (!fs.existsSync(BINDINGS_FILE)) return {};
    const j = JSON.parse(fs.readFileSync(BINDINGS_FILE, "utf-8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function saveBindings(bindings) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = BINDINGS_FILE + ".tmp-" + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(bindings, null, 2), "utf-8");
    fs.renameSync(tmp, BINDINGS_FILE);
  } catch {}
}

/** 查找某 peer 当前绑定的会话（无则 null）。 */
export function findBoundSession(bindings, channel, peerId) {
  for (const [sessionId, peers] of Object.entries(bindings)) {
    if ((peers || []).some((p) => p.channel === channel && p.peerId === peerId)) return sessionId;
  }
  return null;
}

/** 查找某会话绑定的全部 peer（用于推送通知）。 */
export function findPeersForSession(bindings, sessionId) {
  return bindings[sessionId] || [];
}

/** 绑定/解绑（同一 peer 重新绑定 = 覆盖）。 */
export function setBinding(bindings, channel, peerId, sessionId) {
  // 先从旧位置移除该 peer
  for (const [sid, peers] of Object.entries(bindings)) {
    bindings[sid] = (peers || []).filter((p) => !(p.channel === channel && p.peerId === peerId));
    if (bindings[sid].length === 0) delete bindings[sid];
  }
  if (sessionId) {
    (bindings[sessionId] ||= []).push({ channel, peerId, boundAt: new Date().toISOString() });
  }
  saveBindings(bindings);
  return bindings;
}

/** 从会话事件流提取某 callId 的工具调用详情（命令展示用）。 */
function extractCallDetail(session, callId) {
  try {
    for (const ev of sessionEvents(session)) {
      if (ev.type === "tool/call" && (ev.data?.callId === callId || ev.data?.id === callId)) {
        const name = ev.data.name || ev.data.toolName || "";
        const params = ev.data.params || ev.data.arguments || ev.data.input || {};
        let detail = name;
        try {
          const ps = typeof params === "string" ? JSON.parse(params) : params;
          const summary = JSON.stringify(ps);
          if (summary && summary !== "{}" && summary !== "\"\"") detail += " " + summary.slice(0, 300);
        } catch {
          if (params) detail += " " + String(params).slice(0, 300);
        }
        return detail || name;
      }
    }
  } catch {}
  return null;
}

/**
 * 创建远程监控器。
 * @param ctx cordis ctx
 * @param deps { push: (channel, peerId, text) => Promise<void> }
 */
export function createRemoteMonitor(ctx, deps) {
  const bindings = loadBindings();
  const pending = new Map(); // approvalId -> { resolve, timer, sessionId }

  /** 向绑定该会话的所有 peer 推送文本。 */
  async function notifySession(sessionId, text) {
    for (const p of findPeersForSession(bindings, sessionId)) {
      try {
        await deps.push(p.channel, p.peerId, text);
      } catch (e) {
        ctx.logger?.warn?.(`dsh-msg-hub: 远程通知失败 ${p.channel}/${p.peerId}: ${String(e)}`);
      }
    }
  }

  /** 应答等待中的审批（用户渠道回复「批准/拒绝」）。 */
  function answerApproval(text) {
    const t = String(text || "").trim();
    if (t === "批准" || t === "同意" || t === "允许" || t === "approve" || t === "yes") return "allowed-once";
    if (t === "拒绝" || t === "不同意" || t === "拒绝执行" || t === "reject" || t === "no") return "rejected";
    return null;
  }

  // ── 审批远程批准：拦截 approval/request waterfall ──
  const stopApproval = ctx.on("approval/request", async (req, next) => {
    try {
      const sessionId = req?.agent?.id;
      if (!sessionId) return next();
      const peers = findPeersForSession(bindings, sessionId);
      if (peers.length === 0) return next(); // 无绑定：走默认流程
      const callDetail = extractCallDetail(req.agent.session, req.callId);
      const reason = req.reason ? `\n原因：${req.reason}` : "";
      const cmd = callDetail ? `\n命令：${callDetail}` : "";
      const prompt = `🔐 需要批准\n工具：${req.toolName || "?"}${reason}${cmd}\n\n回复「批准」或「拒绝」（5 分钟内有效）`;
      for (const p of peers) {
        try { await deps.push(p.channel, p.peerId, prompt); } catch {}
      }
      // 等待用户回复（任一 peer 回复即可）
      const id = req.callId || req.agent.id + ":" + Date.now();
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve("rejected"); // 超时 fail-closed
        }, APPROVAL_TIMEOUT_MS);
        pending.set(id, {
          resolve: (outcome) => {
            clearTimeout(timer);
            pending.delete(id);
            resolve(outcome);
          },
        });
      });
    } catch (e) {
      ctx.logger?.warn?.(`dsh-msg-hub: approval 拦截异常 ${String(e)}`);
      return next();
    }
  });

  // ── turn 状态推送：监听绑定会话的 agent 状态 ──
  const stopStatus = ctx.on("agent/status", ({ agent, status }) => {
    try {
      if (!agent?.id) return;
      const peers = findPeersForSession(bindings, agent.id);
      if (peers.length === 0) return;
      const map = {
        running: "▶️ 任务开始",
        idle: "✅ 任务完成",
        error: "❌ 任务出错",
        blocked: "⏸️ 任务被阻塞（等待输入/批准）",
      };
      const label = map[status];
      if (!label) return;
      notifySession(agent.id, `${label}（${agent.id.slice(0, 16)}…）`);
    } catch {}
  });

  // ── 渠道消息命令拦截（由 bridge 调用） ──
  /** 处理 /sessions /bind /status 命令；命中返回 true（不再转发给 agent）。 */
  async function handleCommand(channel, peerId, text, sessionsSvc) {
    const t = String(text || "").trim();
    const reply = (msg) => deps.push(channel, peerId, msg);
    if (t === "/sessions" || t === "/会话") {
      try {
        const list = (typeof sessionsSvc?.list === "function" ? sessionsSvc.list() : []) || [];
        const recent = list.slice(-5).reverse();
        if (recent.length === 0) {
          await reply("当前没有会话。请在 Web 端开始一个任务后重试。");
          return true;
        }
        const lines = recent.map((s) => {
          const id = s.id || "?";
          const title = s.title || s.displayTitle || "(无标题)";
          return `${title} · ${id}`;
        });
        await reply(`最近 ${recent.length} 个会话（用 /bind 后面接会话 ID 绑定）：\n` + lines.join("\n"));
        return true;
      } catch (e) {
        await reply("/sessions 失败：" + String(e).slice(0, 100));
        return true;
      }
    }
    if (t.startsWith("/bind")) {
      const sid = t.replace("/bind", "").trim();
      if (!sid) {
        const cur = findBoundSession(bindings, channel, peerId);
        await reply(cur ? `当前绑定：${cur}` : "未绑定会话。用法：/bind <会话ID>（用 /sessions 查看列表）");
        return true;
      }
      setBinding(bindings, channel, peerId, sid);
      await reply(`已绑定会话：${sid}\n该会话的任务状态与审批请求将推送到这里。`);
      return true;
    }
    if (t === "/status" || t === "/状态") {
      const cur = findBoundSession(bindings, channel, peerId);
      await reply(cur ? `📌 绑定会话：${cur}\n状态推送与远程批准已开启。` : "未绑定会话。用 /sessions 查看会话列表，/bind <会话ID> 绑定。");
      return true;
    }
    // ── 会话常驻治理：/new 开新会话、/release 释放本渠道会话、/cfg 查看/设置策略 ──
    if (t === "/new" || t === "/新会话") {
      try {
        const r = await deps.rotate(channel, peerId);
        if (r && r.ok === false) { await reply("/new 失败：" + (r.error || "未知错误")); return true; }
        const note = r.released && r.released.length > 0 ? "（旧会话已释放）" : "";
        await reply(`已开新会话 ✅ 会话 ID 保持不变（永远干净），新会话自动继承上一段会话的最近对话摘要，记忆无缝接续。\n旧会话已归档为时间戳备份：${r.archived || "（旧会话暂无落盘文件）"}${note}\n会话 ID：${r.sessionId}`);
      } catch (e) {
        await reply("/new 失败：" + String(e).slice(0, 100));
      }
      return true;
    }
    if (t === "/release" || t === "/释放") {
      try {
        const r = await deps.releaseTarget(channel, peerId);
        await reply(r.released.length > 0
          ? `已释放本渠道常驻会话 ✓（会话已落盘，下次消息自动恢复）`
          : "本渠道会话当前不在常驻列表中（已按策略自动释放）");
      } catch (e) {
        await reply("/release 失败：" + String(e).slice(0, 100));
      }
      return true;
    }
    if (t === "/cfg" || t.startsWith("/cfg ")) {
      try {
        const parts = t.replace("/cfg", "").trim().split(/\s+/);
        if (parts.length >= 1 && parts[0].toLowerCase() === "keepalive") {
          const onOff = parts[1]?.toLowerCase();
          if (onOff === "on" || onOff === "off") {
            const count = parts.length >= 3 ? Number(parts[2]) : undefined;
            const cfg = deps.setCfg({ keepAliveSessions: { enabled: onOff === "on", count } });
            await reply(`已设置：会话常驻= ${cfg.keepAliveSessions.enabled ? "开" : "关"}，保留个数= ${cfg.keepAliveSessions.count}（1~5）`);
          } else {
            await reply("用法 /cfg keepalive on|off [1-5]（如 /cfg keepalive on 3）");
          }
        } else if (parts.length >= 1 && parts[0].toLowerCase() === "inherit") {
          const n = parts[1] === undefined ? undefined : Number(parts[1]);
          if (n === undefined || Number.isFinite(n)) {
            const cfg = deps.setCfg({ inheritRecentCount: n });
            await reply(`已设置：记忆继承条数 = ${cfg.inheritRecentCount}（1~30，默认 10）`);
          } else {
            await reply("用法 /cfg inherit <1-30>（如 /cfg inherit 10）");
          }
        } else if (parts.length >= 1 && parts[0].toLowerCase() === "sweep") {
          const n = parts[1] === undefined ? undefined : Number(parts[1]);
          if (n === undefined || Number.isFinite(n)) {
            const cfg = deps.setCfg({ sweepIntervalMinutes: n });
            await reply(`已设置：自动释放间隔 = ${cfg.sweepIntervalMinutes} 分钟（0=不自动，1~60；每到间隔自动保留最近 ${cfg.keepAliveSessions.count} 个常驻会话、释放其余）`);
          } else {
            await reply("用法 /cfg sweep <0-60>（0=不自动，如 /cfg sweep 5）");
          }
        } else {
          const cfg = deps.getCfg();
          await reply(`📊 渠道会话策略：\n· 常驻：${cfg.keepAliveSessions.enabled ? "开" : "关"}，保留最近 ${cfg.keepAliveSessions.count} 个活跃会话\n· 自动释放间隔：${cfg.sweepIntervalMinutes === 0 ? "不自动（手动释放）" : cfg.sweepIntervalMinutes + " 分钟"}\n· /new 记忆继承条数：${cfg.inheritRecentCount} 条 ${cfg.inheritRecentCount >= 20 ? "⚠️" : ""}（建议最大 30，数值越大注入上下文越长，内存占用越高）\n\n设置：/cfg keepalive on|off [1-5]；/cfg sweep <0-60>；/cfg inherit <1-30>`);
        }
      } catch (e) {
        await reply("/cfg 失败：" + String(e).slice(0, 100));
      }
      return true;
    }
    // 审批应答：仅在存在 pending 且文本匹配时消费
    if (pending.size > 0) {
      const outcome = answerApproval(t);
      if (outcome) {
        const first = pending.values().next().value;
        if (first) {
          first.resolve(outcome);
          await reply(outcome === "allowed-once" ? "✅ 已批准" : "🚫 已拒绝");
          return true;
        }
      }
    }
    return false;
  }

  return {
    bindings,
    handleCommand,
    notifySession,
    stop: () => { try { stopApproval(); } catch {} try { stopStatus(); } catch {} },
  };
}
