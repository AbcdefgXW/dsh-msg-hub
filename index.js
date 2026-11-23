/**
 * index.js — dsh-msg-hub cordis 插件入口
 *
 * 挂载进 dsh web profile（cordis.patch.yml），随 dsh 进程启停：
 *   1. 创建 bridge（agents/sessions/agentDefaultModel 服务注入）
 *   2. 启动所有已配置微信账户的 monitor
 *   3. 启动所有已配置 QQ 机器人（WebSocket 官方通道）
 *   4. 渠道消息 → bridge.inbound → 回复回传（各渠道独立会话）
 *
 * 登录不在此处（交互式扫码走 scripts/weixin-login.mjs / qq-login.mjs），
 * 凭证落盘后本插件自动加载对应账户。
 */
import { createBridge, getChannelsCfg, setChannelsCfg } from "./lib/bridge.js";
import { startWeixinMonitors, sendWeixinText, getWeixinSegmentLimit, setWeixinSegmentLimit } from "./lib/weixin/adapter.js";
import { startQqBots, sendQqText } from "./lib/qq/adapter.js";
import { startFeishuBots, sendFeishuText } from "./lib/feishu/adapter.js";
import { listWeixinAccountIds, resolveWeixinAccount } from "./dist/protocol/auth/accounts.js";
import { logger } from "./dist/protocol/util/logger.js";
import { diagLog } from "./lib/diag.js";
import { createRemoteMonitor } from "./lib/remote.js";
import { Service } from "@deepseek-ai/cordis";

const qqRecentMessages = new Map();
export const name = "dsh-msg-hub";

export const inject = ["agents", "sessions", "agentDefaultModel"];

/**
 * 主动推送服务（供其他插件调用，如 dsh-toolbox 定时心跳推送渠道）。
 * - push({channel, peerId, text})：直接发文本到 IM（不经过 agent）
 * - task({channel, peerId, prompt})：完整流程——唤醒渠道 agent 执行 prompt，回复回传 IM
 * - registerChannel(channel, adapter)：**适配器注册表**——第三方插件可注册自己的渠道
 *   adapter = { send: (peerId, text) => Promise, matchSessionId?: (sessionId) => boolean }
 *   （内置 weixin/qq/feishu 已注册；注册后 push/task 与 sessionId 解析自动支持该渠道）
 * - resolveChannel(sessionId)：把 ch-<channel>-<peerId> 会话 ID 解析为 {channel, peerId}
 * peerId 与 dsh-msg-hub 会话 ID 反推一致（如 ch-weixin-<peerId>）。
 */
export class ChannelsPushApi extends Service {
  constructor(ctx, deps) {
    super(ctx, "dsh-channels-push");
    this.deps = deps; // { bridge, getWeixinAccount, getQqBot, getFeishuClient }
    /** 适配器注册表：channel -> adapter */
    this.channels = new Map();
  }

  /** 注册渠道适配器（第三方渠道插件接入点）。 */
  registerChannel(channel, adapter) {
    if (!channel || typeof channel !== "string") throw new TypeError("channel 必须是非空字符串");
    if (!adapter || typeof adapter.send !== "function") throw new TypeError("adapter 必须提供 send(peerId, text)");
    this.channels.set(channel, adapter);
    return { ok: true, channel };
  }

  /** 通过会话 ID 解析渠道（优先注册表 matchSessionId，内置前缀兜底）。 */
  resolveChannel(sessionId) {
    const s = String(sessionId || "");
    // 轮换后的 ID 带 -N 尾缀（ch-weixin-<openid>-2），反解时剥掉，不影响真实 peerId
    const stripEpoch = (pid) => String(pid).replace(/-\d+$/, "");
    for (const [channel, adapter] of this.channels) {
      if (typeof adapter.matchSessionId === "function" && adapter.matchSessionId(s)) {
        const prefix = "ch-" + channel + "-";
        if (s.startsWith(prefix)) return { channel, peerId: stripEpoch(s.slice(prefix.length)) };
      }
    }
    // 内置前缀兜底
    for (const [prefix, channel] of [["ch-weixin-", "weixin"], ["ch-qq-", "qq"], ["ch-feishu-", "feishu"]]) {
      if (s.startsWith(prefix)) return { channel, peerId: stripEpoch(s.slice(prefix.length)) };
    }
    return null;
  }

  /** 读取渠道配置（如 weixin.segmentLimit）。 */
  getChannelConfig(channel, key) {
    if (channel === "weixin" && key === "segmentLimit") return { ok: true, value: getWeixinSegmentLimit() };
    return { ok: false, error: "未知配置: " + String(channel) + "." + String(key) };
  }

  /** 设置渠道配置（如 weixin.segmentLimit，即时生效）。 */
  setChannelConfig(channel, key, value) {
    if (channel === "weixin" && key === "segmentLimit") return { ok: true, value: setWeixinSegmentLimit(Number(value)) };
    return { ok: false, error: "未知配置: " + String(channel) + "." + String(key) };
  }

  /** 读取渠道会话常驻策略（keepAliveSessions: {enabled, count}）。 */
  getKeepAliveConfig() {
    return { ok: true, ...getChannelsCfg() };
  }

  /** 读取渠道会话策略全量（常驻 + 继承条数）。 */
  getChannelCfg() {
    return { ok: true, ...getChannelsCfg() };
  }

  /** 更新渠道会话策略全量（patch 透传：keepAliveSessions{enabled,count} / inheritRecentCount）。 */
  updateChannelCfg(patch = {}) {
    return { ok: true, ...setChannelsCfg(patch) };
  }

  /** 设置渠道会话常驻策略：enabled 开关，count 1~5（默认 3）。即时生效并持久化。 */
  setKeepAliveConfig({ enabled, count } = {}) {
    return { ok: true, ...setChannelsCfg({ keepAliveSessions: { enabled, count } }) };
  }

  /**
   * 释放内存：保留最近 keepCount 个活跃渠道会话（缺省按配置），其余释放。
   * 释放 = flush 落盘 + dispose 摘除（下次消息自动 resume）。供工具箱「释放内存」调用。
   */
  async release(keepCount) {
    const r = await this.deps.bridge.release(keepCount);
    return { ok: true, ...r };
  }

  /** 释放指定渠道会话（/release 渠道命令用）。 */
  async releaseTarget(channel, peerId) {
    const r = await this.deps.bridge.releaseTarget(channel, peerId);
    return { ok: true, ...r };
  }

  /** 轮换会话：该渠道用户开新会话（/new 渠道命令用），旧会话释放、历史保留。 */
  async rotate(channel, peerId) {
    const r = await this.deps.bridge.rotate(channel, peerId);
    return { ok: true, ...r };
  }

  async push({ channel, peerId, text }) {
    const d = this.deps;
    try {
      // 统一走适配器注册表（内置 weixin/qq/feishu 已在 apply 时注册）
      const adapter = this.channels.get(channel);
      if (adapter) {
        await adapter.send(peerId, text);
        return { ok: true, channel, peerId };
      }
      return { ok: false, error: "未知渠道 " + channel + "（未注册适配器，可用 registerChannel 注册）" };
    } catch (err) {
      diagLog(`[channels-push] ${channel}/${peerId} 发送失败: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return { ok: false, error: String(err) };
    }
  }

  /** 唤醒渠道 agent 执行任务，AI 回复自动回传 IM（复用 bridge.inbound 完整流程，会话存留按常驻策略）。 */
  async task({ channel, peerId, prompt }) {
    const d = this.deps;
    try {
      const outcome = await d.bridge.inbound({
        channel,
        peerId,
        text: prompt,
        reply: async (replyText) => {
          const r = await this.push({ channel, peerId, text: replyText });
          if (!r.ok) diagLog(`[channels-task] 回传失败 ${channel}/${peerId}: ${r.error}`);
        },
      });
      return { ok: true, outcome };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }
}

export function apply(ctx) {
  const bridge = createBridge(ctx);
  const log = ctx.logger ?? logger;

  // 供 ChannelsPushApi 使用的运行时依赖（账户/bot/client 实例）
  let qqBotsMap = new Map();
  let feishuClientsMap = new Map();
  const deps = {
    bridge,
    getWeixinAccount: () => {
      const ids = listWeixinAccountIds();
      for (const id of ids) {
        const acc = resolveWeixinAccount(id);
        if (acc.configured) return acc;
      }
      return null;
    },
    getQqBot: () => (qqBotsMap.size > 0 ? [...qqBotsMap.values()][0] : null),
    getFeishuClient: () => (feishuClientsMap.size > 0 ? [...feishuClientsMap.values()][0] : null),
  };
  const pushApi = new ChannelsPushApi(ctx, deps);
  // 内置三渠道注册进适配器注册表（第三方插件可用 registerChannel 继续扩展）
  pushApi.registerChannel("weixin", {
    send: async (peerId, text) => {
      const acc = deps.getWeixinAccount();
      if (!acc) throw new Error("无已配置微信账户");
      await sendWeixinText(acc, peerId, text);
    },
    matchSessionId: (id) => String(id).startsWith("ch-weixin-"),
  });
  pushApi.registerChannel("qq", {
    send: async (peerId, text) => {
      const bot = deps.getQqBot();
      if (!bot) throw new Error("无 QQ bot 在线");
      if (!String(peerId).startsWith("c2c:")) throw new Error("QQ 群聊推送暂不支持（仅 c2c 私聊）");
      await sendQqText(bot, { scope: "c2c", targetId: String(peerId).slice(4) }, text);
    },
    matchSessionId: (id) => String(id).startsWith("ch-qq-"),
  });
  pushApi.registerChannel("feishu", {
    send: async (peerId, text) => {
      const client = deps.getFeishuClient();
      if (!client) throw new Error("无飞书 client 在线");
      if (!String(peerId).startsWith("p2p:")) throw new Error("飞书群聊推送暂不支持（仅 p2p 私聊）");
      await sendFeishuText(client, String(peerId).slice(4), text);
    },
    matchSessionId: (id) => String(id).startsWith("ch-feishu-"),
  });
  log.info("dsh-msg-hub: push 服务已提供（dsh-channels-push，含适配器注册表）");

  // ── 远程监控：审批远程批准 / turn 推送 / /sessions /bind /status /new /release /cfg ──
  const remote = createRemoteMonitor(ctx, {
    push: async (channel, peerId, text) => {
      const r = await pushApi.push({ channel, peerId, text });
      if (!r.ok) log.warn(`dsh-msg-hub: 远程推送失败 ${channel}/${peerId}: ${r.error}`);
    },
    rotate: (channel, peerId) => bridge.rotate(channel, peerId),
    releaseTarget: (channel, peerId) => bridge.releaseTarget(channel, peerId),
    release: (keepCount) => bridge.release(keepCount),
    getCfg: () => getChannelsCfg(),
    setCfg: (patch) => setChannelsCfg(patch),
  });
  log.info("dsh-msg-hub: 远程监控已启用（/sessions /bind /status + 审批远程批准）");
  ctx.on("dispose", () => remote.stop());

  // ── 微信 ──
  async function handleWeixinMessage(text, peerId, contextToken) {
    // 远程监控命令（/sessions /bind /status /审批应答）优先拦截
    const sessionsSvc = ctx.get("sessions");
    if (await remote.handleCommand("weixin", peerId, text, sessionsSvc)) return;
    // 找到 peerId 对应的账户（token/contextToken 匹配）；简化：用第一个已配置账户
    const account = resolveFirstConfiguredAccount();
    if (!account) {
      log.warn("没有已配置的微信账户，忽略消息");
      return;
    }
    await bridge.inbound({
      channel: "weixin",
      peerId,
      text,
      reply: async (replyText) => {
        await sendWeixinText(account, peerId, replyText, contextToken);
      },
    });
  }

  function resolveFirstConfiguredAccount() {
    const ids = listWeixinAccountIds();
    for (const id of ids) {
      const acc = resolveWeixinAccount(id);
      if (acc.configured) return acc;
    }
    return null;
  }

  const stopWeixin = startWeixinMonitors({ onMessage: handleWeixinMessage });
  log.info("dsh-msg-hub: weixin monitors started");

  // ── QQ ──
  const qqRuntime = { bots: new Map(), stop: () => {} };
  startQqBots({
    onMessage: async (text, peerKey, replyTarget, msg, bot) => {
      // 去重：平台会把同一条群 @ 推两种事件；按 会话+内容 3 秒窗口合并
      try {
        const now = Date.now();
        const dkey = peerKey + "|" + text;
        const last = qqRecentMessages.get(dkey) || 0;
        if (now - last < 3000) return;
        qqRecentMessages.set(dkey, now);
        if (qqRecentMessages.size > 500) {
          for (const [k, t] of qqRecentMessages) if (now - t > 60000) qqRecentMessages.delete(k);
        }
      } catch {}
      const sessionsSvc = ctx.get("sessions");
      if (await remote.handleCommand("qq", peerKey, text, sessionsSvc)) return;
      await bridge.inbound({
        channel: "qq",
        peerId: peerKey,
        text,
        reply: async (replyText) => {
          await sendQqText(bot, replyTarget, replyText);
        },
      });
    },
  })
    .then((runtime) => {
      qqRuntime.bots = runtime.bots;
      qqBotsMap = runtime.bots;
      qqRuntime.stop = runtime.stop;
      log.info(`dsh-msg-hub: qq bots started (${runtime.bots.size})`);
    })
    .catch((err) => {
      diagLog(`[qq] 启动失败: ${String(err)}`);
    });

  // ── 飞书 ──
  const feishuRuntime = { clients: new Map(), stop: () => {} };
  startFeishuBots({
    onMessage: async (text, peerKey, event, client) => {
      const openId = event?.sender?.sender_id?.open_id ?? "";
      if (!openId) return;
      const sessionsSvc = ctx.get("sessions");
      if (await remote.handleCommand("feishu", peerKey, text, sessionsSvc)) return;
      await bridge.inbound({
        channel: "feishu",
        peerId: peerKey,
        text,
        reply: async (replyText) => {
          await sendFeishuText(client, openId, replyText);
        },
      });
    },
  })
    .then((runtime) => {
      feishuRuntime.clients = runtime.clients;
      feishuClientsMap = runtime.clients;
      feishuRuntime.stop = runtime.stop;
      log.info(`dsh-msg-hub: feishu bots started (${runtime.clients.size})`);
    })
    .catch((err) => {
      diagLog(`[feishu] 启动失败: ${String(err)}`);
    });

  // 卸载时停止
  ctx.on("dispose", () => {
    log.info("dsh-msg-hub: stopping");
    stopWeixin();
    qqRuntime.stop();
    feishuRuntime.stop();
  });
}
