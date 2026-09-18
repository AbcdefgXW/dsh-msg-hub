/**
 * adapter.js — QQ 适配器（QQ 开放平台官方 API v2）
 *
 * 用 @tencent-connect/qqbot-nodejs 的 QQBot：
 *   - WebSocket 长连接收发（官方通道）
 *   - bot.on('message') 收消息 → bridge.inbound
 *   - bot.sendText 回复
 *
 * 凭证：state/qq/accounts.json（扫码绑定写入，见 scripts/qq-login.mjs）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QQBot, FileKVStore, kvSessionPersistence } from "@tencent-connect/qqbot-nodejs";
import { listQqAccounts } from "./credentials.js";
import { diagLog } from "../diag.js";
import { saveMedia, mediaHint, guessImageExt } from "../media.js";
import { transcribeAudio, isAsrEnabled } from "../asr.js";

function resolveQqDataDir(appId) {
  return path.join(
    process.env.DSH_CHANNELS_STATE_DIR?.trim() ||
      path.join(fileURLToPath(new URL("../../", import.meta.url)), "state", "qq", "data"),
    String(appId),
  );
}

/**
 * 解析入站消息内容（文本 / 图片 / 语音）。
 *
 * - 文本：直接用 content
 * - 语音：QQ 官方在 attachment 里已给 asr_refer_text（转写好的文字）→ 直接采用，
 *         不花自建 ASR 的钱；为空时才兜底下载 voice_wav_url 走 ASR
 * - 图片：attachment.url 是直链（无需解密，区别于微信）→ 下载落盘 → read_image
 *
 * @param {object} msg SDK 的入站消息对象
 * @returns {Promise<string>} 给模型看的文本；无法处理时返回空字符串
 */
export async function extractQqContent(msg) {
  if (!msg) return "";
  const raw = typeof msg.content === "string" ? msg.content.trim() : "";
  if (raw) return raw;

  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (!atts.length) return "";

  const parts = [];
  for (const a of atts) {
    const type = String(a?.content_type ?? "").toLowerCase();
    try {
      if (type === "voice") {
        // 官方已转写：免费、即时，且比自建 ASR 更准
        const ref = typeof a.asr_refer_text === "string" ? a.asr_refer_text.trim() : "";
        if (ref) {
          diagLog(`[qq] 语音使用官方转写: "${ref.slice(0, 40)}"`);
          parts.push(`[语音] ${ref}`);
          continue;
        }
        // 兜底：下载 WAV 自己转写
        const wavUrl = a.voice_wav_url || a.url;
        if (!wavUrl) continue;
        if (!isAsrEnabled()) {
          diagLog("[qq] 收到语音：官方未给转写文本，且未配置 ASR（缺 state/asr.env）已跳过");
          continue;
        }
        const vr = await fetch(wavUrl, { signal: AbortSignal.timeout(60_000) });
        if (!vr.ok) throw new Error(`语音下载 HTTP ${vr.status}`);
        const vbuf = Buffer.from(await vr.arrayBuffer());
        const t = await transcribeAudio(vbuf, { filename: "voice.wav", mime: "audio/wav" });
        if (t) parts.push(`[语音] ${t}`);
        continue;
      }
      if (type.startsWith("image")) {
        if (!a.url) continue;
        const ir = await fetch(a.url, { signal: AbortSignal.timeout(60_000) });
        if (!ir.ok) throw new Error(`图片下载 HTTP ${ir.status}`);
        const ibuf = Buffer.from(await ir.arrayBuffer());
        const file = saveMedia(ibuf, { channel: "qq", ext: guessImageExt(ibuf) });
        if (file) {
          diagLog(`[qq] 图片已保存 ${ibuf.length} 字节: ${file}`);
          parts.push(mediaHint(file, { kind: "图片" }));
        }
        continue;
      }
      diagLog(`[qq] 收到暂不支持的附件类型: ${type}（filename=${a.filename ?? "?"}）`);
    } catch (e) {
      diagLog(`[qq] 附件处理失败（type=${type}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return parts.join("\n");
}

/**
 * 启动一个 QQBot 账户。
 * @param {object} account {appId, appSecret}
 * @param {object} opts
 * @param {(text: string, peerKey: string, replyTarget: object, msg) => Promise<void>} opts.onMessage
 * @param {AbortSignal} [opts.abortSignal]
 * @returns {Promise<() => void>} stop 函数
 */
export async function startQqBotAccount(account, { onMessage, abortSignal }) {
  const bot = new QQBot({
    appId: account.appId,
    appSecret: account.appSecret,
    accountId: account.appId,
    markdownSupport: true,
    userAgent: `dsh-msg-hub/0.1.0 (Node/${process.version})`,
    transport: "websocket",
    sessionPersistence: kvSessionPersistence({
      store: new FileKVStore({ dir: resolveQqDataDir(account.appId), fileName: "session.json" }),
      accountId: account.appId,
    }),
    tokenPrefetch: "sync",
    logger: {
      info: (m) => diagLog(`[qq ${account.appId}] ${m}`),
      warn: (m) => diagLog(`[qq ${account.appId}] WARN ${m}`),
      error: (m) => diagLog(`[qq ${account.appId}] ERROR ${m}`),
      debug: () => {},
    },
  });

  const handleMessage = async (ctx, msg) => {
    let text = "";
    try {
      text = await extractQqContent(msg);
    } catch (err) {
      diagLog(`[qq ${account.appId}] 内容解析失败: ${String(err)}`);
      return;
    }
    if (!text) return;
    // 会话键：c2c 私聊用用户 openid；群聊用 群openid:发送者openid（群内每人独立记忆）
    const scope = msg.replyTarget?.scope ?? msg.kind ?? "c2c";
    const targetId = msg.replyTarget?.targetId ?? msg.senderId;
    const senderId = msg.senderId ?? targetId;
    const peerKey = scope === "group" ? `group:${targetId}:${senderId}` : `c2c:${senderId}`;
    diagLog(`[qq ${account.appId}] 收到消息 ${scope} from=${senderId} text="${text.slice(0, 40)}"`);
    Promise.resolve(onMessage(text, peerKey, msg.replyTarget, msg, bot)).catch((err) => {
      diagLog(`[qq ${account.appId}] onMessage 失败: ${String(err)}`);
    });
  };

  const handleReady = () => {
    attempt = 0; // 连上了就重置退避计数
    diagLog(`[qq ${account.appId}] bot ready`);
  };

  bot.on("message", handleMessage);
  bot.on("ready", handleReady);
  bot.on("resumed", handleReady);
  bot.on("error", (err) => {
    diagLog(`[qq ${account.appId}] bot error: ${err.message}`);
  });

  // 注意：bot.start() 的 promise 要等 WebSocket 断开才 resolve（长连接语义），
  // 不能 await——后台跑，用 ready 事件（带超时）确认启动成功。
  // 断开或启动失败后自动重连（指数退避 30s→60s→120s→240s→上限 5min），
  // 否则启动瞬间一次网络抖动就会导致永久掉线（实测重启时必现）。
  let stopped = false;
  let attempt = 0;
  abortSignal?.addEventListener("abort", () => {
    stopped = true;
  }, { once: true });
  const connect = () => {
    if (stopped) return;
    attempt += 1;
    bot
      .start()
      .catch((err) => {
        diagLog(`[qq ${account.appId}] start() 结束（连接断开）: ${String(err)}`);
      })
      .finally(() => {
        if (stopped) return;
        const delay = Math.min(30_000 * 2 ** Math.min(attempt - 1, 4), 5 * 60_000);
        diagLog(`[qq ${account.appId}] ${Math.round(delay / 1000)} 秒后第 ${attempt + 1} 次重连`);
        setTimeout(() => {
          if (!stopped) connect();
        }, delay);
      });
  };
  connect();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      diagLog(`[qq ${account.appId}] 等待 ready/resumed 超时（15s），继续运行`);
      bot.off("ready", onReady);
      bot.off("resumed", onReady);
      bot.off("error", onError);
      resolve();
    }, 15_000);
    const onReady = () => {
      clearTimeout(timer);
      bot.off("ready", onReady);
      bot.off("resumed", onReady);
      bot.off("error", onError);
      resolve();
    };
    const onError = (err) => {
      clearTimeout(timer);
      bot.off("ready", onReady);
      bot.off("resumed", onReady);
      bot.off("error", onError);
      reject(err);
    };
    bot.on("ready", onReady);
    bot.on("resumed", onReady);
    bot.on("error", onError);
  });

  // 返回 bot 实例（供主动推送；stop 由实例自带，startQqBots 的 stops 数组另行收集）
  return bot;
}

/**
 * QQ markdown 预处理：QQ 官方 markdown 支持 标题/加粗/斜体/删除线/链接/列表/引用/分割线/图片，
 * 但代码块/行内代码/表格不支持——降级为文本样式（代码→【代码】、行内码去反引号、表格转对齐文本）。
 */
export function mdForQq(md) {
  return String(md || "")
    .replace(/\`\`\`[a-zA-Z0-9]*\n([\s\S]*?)\`\`\`/g, "【代码】\n$1")
    .replace(/\`([^\`\n]+)\`/g, "$1");
}

/** 发一条文本消息回复（markdown 自动）。 */
export async function sendQqText(bot, replyTarget, text) {
  await bot.sendText(replyTarget, mdForQq(text), { msgId: replyTarget?.msgId });
}

/**
 * 启动所有已配置 QQ 账户。
 * @returns {Promise<{bots: Map<string, QQBot>, stop: () => void}>}
 */
export async function startQqBots({ onMessage, abortSignal }) {
  const accounts = listQqAccounts();
  const bots = new Map();
  const stops = [];

  for (const account of accounts) {
    try {
      const bot = await startQqBotAccount(account, { onMessage, abortSignal });
      bots.set(account.appId, bot);
      stops.push(() => bot.stop?.().catch?.(() => {}));
      diagLog(`[qq] 账户 ${account.appId} 已启动`);
    } catch (err) {
      diagLog(`[qq] 账户 ${account.appId} 启动失败: ${String(err)}`);
    }
  }

  return {
    bots,
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}
