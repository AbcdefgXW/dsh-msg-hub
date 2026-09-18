import fs from "node:fs";
import path from "node:path";

/**
 * adapter.js — 微信适配器（ilinkai 协议）
 *
 * 复用 protocol/ 编译产物（上游 openclaw-weixin 协议层，MIT）：
 *   - getUpdates 长轮询收消息
 *   - sendMessage 发文本
 *   - 账户凭证存储（state/weixin/）
 *
 * 薄壳职责：轮询循环 + 文本提取 + bridge 注入 + 回复回传 + 错误退避。
 */
import {
  getUpdates,
  sendMessage,
  notifyStart,
  notifyStop,
  classifyFetchError,
} from "../../dist/protocol/api/api.js";
import {
  listWeixinAccountIds,
  resolveWeixinAccount,
} from "../../dist/protocol/auth/accounts.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../../dist/protocol/storage/sync-buf.js";
import { resolveStateDir } from "../../dist/protocol/storage/state-dir.js";
import { logger } from "../../dist/protocol/util/logger.js";
import { MessageItemType, MessageType, MessageState } from "../../dist/protocol/api/types.js";
import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from "./upstream/cdn/pic-decrypt.js";
import { silkToWav } from "./upstream/media/silk-transcode.js";
import { saveMedia, mediaHint, guessImageExt } from "../media.js";
import { transcribeAudio, isAsrEnabled } from "../asr.js";

/** 微信 CDN 基址（官方 openclaw-weixin 的 CDN_BASE_URL 常量）。 */
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com";
import { diagLog } from "../diag.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
/** token 失效后的暂停时长（上游默认） */
const STALE_TOKEN_PAUSE_MS = 10 * 60_000;
const STALE_TOKEN_ERRCODE = -14;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

/**
 * 处理微信消息里的图片/语音：下载 → AES 解密 → 落盘（图片）或 silk→WAV 转写（语音）。
 *
 * 图片走「存盘 + read_image」（dsh 原生支持图片输入，纯文本模型会自动降级）；
 * 语音走 ASR 转写（模型听不了音频）。
 * 任何失败都返回空字符串，不影响其它消息。
 *
 * @param {Array} itemList 消息的 item_list
 * @returns {Promise<string>} 给模型看的文本；无可用媒体时为空字符串
 */
export async function handleWeixinMedia(itemList) {
  if (!itemList?.length) return "";

  // ── 图片 ──
  const img = itemList.find((it) => it.type === MessageItemType.IMAGE);
  const imgMedia = img?.image_item?.media;
  if (imgMedia && (imgMedia.encrypt_query_param || imgMedia.full_url)) {
    try {
      // aeskey 两种来源：image_item.aeskey（hex）或 media.aes_key（base64）
      const aesKeyBase64 = img.image_item.aeskey
        ? Buffer.from(img.image_item.aeskey, "hex").toString("base64")
        : imgMedia.aes_key;
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(imgMedia.encrypt_query_param ?? "", aesKeyBase64, CDN_BASE_URL, "weixin image", imgMedia.full_url)
        : await downloadPlainCdnBuffer(imgMedia.encrypt_query_param ?? "", CDN_BASE_URL, "weixin image", imgMedia.full_url);
      const file = saveMedia(buf, { channel: "weixin", ext: guessImageExt(buf) });
      if (!file) return "";
      diagLog(`[weixin] 图片已保存 ${buf.length} 字节: ${file}`);
      return mediaHint(file);
    } catch (e) {
      diagLog(`[weixin] 图片下载/解密失败: ${e instanceof Error ? e.message : String(e)}`);
      return "";
    }
  }

  // ── 语音 ──
  const voice = itemList.find((it) => it.type === MessageItemType.VOICE);
  const vMedia = voice?.voice_item?.media;
  if (vMedia && (vMedia.encrypt_query_param || vMedia.full_url) && vMedia.aes_key) {
    if (!isAsrEnabled()) {
      diagLog("[weixin] 收到语音，但未配置 ASR（缺 state/asr.env）已跳过");
      return "";
    }
    try {
      const silkBuf = await downloadAndDecryptBuffer(vMedia.encrypt_query_param ?? "", vMedia.aes_key, CDN_BASE_URL, "weixin voice", vMedia.full_url);
      const wavBuf = await silkToWav(silkBuf);
      const audio = wavBuf ?? silkBuf;
      diagLog(`[weixin] 语音已解密 ${silkBuf.length} 字节${wavBuf ? `，silk→WAV 转码后 ${wavBuf.length} 字节` : "（转码不可用，按原始 silk 送转写）"}，开始转写`);
      const t = await transcribeAudio(audio, {
        filename: wavBuf ? "voice.wav" : "voice.silk",
        mime: wavBuf ? "audio/wav" : "audio/silk",
      });
      return t ? `[语音转写] ${t}` : "";
    } catch (e) {
      diagLog(`[weixin] 语音下载/转码失败: ${e instanceof Error ? e.message : String(e)}`);
      return "";
    }
  }

  // ── 探针：其余类型记录结构，便于后续接入 ──
  for (const [type, label] of [
    [MessageItemType.VOICE, "语音"],
    [MessageItemType.IMAGE, "图片"],
  ]) {
    const hit = itemList.find((it) => it.type === type);
    if (!hit) continue;
    try {
      diagLog(`[weixin] 收到${label}消息但缺少下载所需字段，原始结构: ${JSON.stringify(hit).slice(0, 800)}`);
    } catch {
      // 不可序列化字段时忽略
    }
  }
  return "";
}

/**
 * 提取消息里的第一段文本。
 *
 * 非文本（语音/图片等）当前不处理；命中语音时记一条诊断日志，
 * 便于拿到真实样本后接入转写（见 lib/asr.js）。
 */
export function extractTextBody(itemList) {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  // 探针：命中语音/图片时记录原始结构，便于拿到真实样本后接入转写/识图
  for (const [type, label] of [
    [MessageItemType.VOICE, "语音"],
    [MessageItemType.IMAGE, "图片"],
  ]) {
    const hit = itemList.find((it) => it.type === type);
    if (!hit) continue;
    try {
      diagLog(`[weixin] 收到${label}消息（尚未接入），原始结构: ${JSON.stringify(hit).slice(0, 400)}`);
    } catch {
      // 不可序列化字段时忽略
    }
  }
  return "";
}

/** ilinkai 单条文本消息上限默认值（实测 1280 完整、1380 被拒；默认 1200 留余量，可配置）。 */
const WEIXIN_TEXT_SEGMENT_DEFAULT = 1200;
const WEIXIN_CONFIG_FILE = () => path.join(resolveStateDir(), "weixin", "config.json");

/** 读取微信分段上限（state/weixin/config.json 的 segmentLimit；无则默认 1200）。 */
export function getWeixinSegmentLimit() {
  try {
    const j = JSON.parse(fs.readFileSync(WEIXIN_CONFIG_FILE(), "utf-8"));
    const n = Number(j && j.segmentLimit);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 5000);
  } catch {}
  return WEIXIN_TEXT_SEGMENT_DEFAULT;
}

/** 设置微信分段上限（写入 state/weixin/config.json，即时生效无需重启）。 */
export function setWeixinSegmentLimit(n) {
  const v = Math.max(1, Math.min(Number(n) || WEIXIN_TEXT_SEGMENT_DEFAULT, 5000));
  const file = WEIXIN_CONFIG_FILE();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ segmentLimit: v }, null, 2), "utf-8");
  } catch {}
  return v;
}

/** 按上限切分长文本：切点优先级 = 空行 > 非表格行边界 > 硬切（避免拆断句子/表格）。 */
function segmentText(text, limit) {
  if (!text || text.length <= limit) return [text];
  const W = 160; // 切点搜索窗口
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    // 1) limit 之后第一个空行处——最理想的切点
    const after = rest.slice(limit, limit + W);
    const dblAfter = after.indexOf("\n\n");
    if (dblAfter >= 0 && dblAfter <= W) cut = limit + dblAfter + 1;
    // 2) limit 之前最近的空行
    if (cut < 0) {
      const lastDbl = rest.lastIndexOf("\n\n", limit);
      if (lastDbl >= limit - W) cut = lastDbl + 2;
    }
    // 3) limit 之前最近的非表格行边界（行首不是 |）
    if (cut < 0) {
      let pos = rest.lastIndexOf("\n", limit);
      while (pos > limit - W) {
        const lineEnd = pos;
        const nextNl = rest.indexOf("\n", pos + 1);
        const line = rest.slice(pos + 1, nextNl < 0 ? rest.length : nextNl);
        if (!line.trim().startsWith("|")) { cut = pos + 1; break; }
        pos = rest.lastIndexOf("\n", pos - 1);
      }
    }
    // 4) 硬切
    if (cut < 0) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) parts.push(rest);
  return parts;
}

/** 发一条文本消息给用户（超长自动分段发送，避免上游截断）。 */
export async function sendWeixinText(account, to, text, contextToken) {
  const segments = segmentText(text, getWeixinSegmentLimit());
  for (let i = 0; i < segments.length; i += 1) {
    const part = segments[i];
    await sendMessage({
      baseUrl: account.baseUrl,
      token: account.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: `dsh-msg-hub:${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: part } }],
          context_token: contextToken ?? undefined,
        },
      },
    });
    // 多段之间留 300ms，避免连发触发风控
    if (i < segments.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * 单个账户的收消息循环（getUpdates 长轮询）。
 * @param {object} opts
 * @param {object} opts.account ResolvedWeixinAccount
 * @param {(text: string, peerId: string, contextToken?: string) => Promise<void>} opts.onMessage
 * @param {AbortSignal} [opts.abortSignal]
 */
export async function monitorWeixinAccount({ account, onMessage, abortSignal }) {
  const aLog = logger.withAccount(account.accountId);
  const syncFilePath = getSyncBufFilePath(account.accountId);
  let getUpdatesBuf = loadGetUpdatesBuf(syncFilePath) ?? "";
  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;
  let pausedUntil = 0;

  aLog.info(`Monitor started: baseUrl=${account.baseUrl} account=${account.accountId}`);
  try {
    await notifyStart({ baseUrl: account.baseUrl, token: account.token });
  } catch {
    // best-effort
  }

  while (!abortSignal?.aborted) {
    // token 失效暂停窗口
    if (pausedUntil > Date.now()) {
      const waitMs = pausedUntil - Date.now();
      aLog.error(`token stale, pausing ${Math.ceil(waitMs / 60000)} min`);
      try {
        await sleep(waitMs, abortSignal);
      } catch {
        break;
      }
      continue;
    }

    try {
      const resp = await getUpdates({
        baseUrl: account.baseUrl,
        token: account.token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);
      if (isApiError) {
        if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
          pausedUntil = Date.now() + STALE_TOKEN_PAUSE_MS;
          consecutiveFailures = 0;
          continue;
        }
        consecutiveFailures += 1;
        aLog.error(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;
      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const list = resp.msgs ?? [];
      for (const full of list) {
        const fromUserId = full.from_user_id ?? "";
        if (!fromUserId) continue;
        const text = extractTextBody(full.item_list);
        // 非文本消息（图片/语音）：下载 → AES 解密 → 图片落盘 / 语音 silk→WAV 转写
        const finalText = text || (await handleWeixinMedia(full.item_list));
        aLog.info(`inbound message: from=${fromUserId} text="${finalText.slice(0, 40)}"`);
        if (!finalText) continue;
        // 不在 await 中阻塞轮询：串行处理但捕获异常
        try {
          await onMessage(finalText, fromUserId, full.context_token);
        } catch (err) {
          aLog.error(`onMessage failed: ${String(err)}`);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        aLog.info("Monitor stopped (aborted)");
        break;
      }
      consecutiveFailures += 1;
      const classified = classifyFetchError(err);
      aLog.error(`getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)} type=${classified.type}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }

  try {
    await notifyStop({ baseUrl: account.baseUrl, token: account.token });
  } catch {
    // best-effort
  }
  aLog.info("Monitor ended");
}

/**
 * 启动所有已配置账户的监控。
 * @param {(text: string, peerId: string, contextToken?: string) => Promise<void>} onMessage
 * @param {AbortSignal} [abortSignal]
 * @returns {() => void} stop 函数
 */
export function startWeixinMonitors({ onMessage, abortSignal }) {
  const stopFns = [];
  const ids = listWeixinAccountIds();
  for (const id of ids) {
    try {
      const account = resolveWeixinAccount(id);
      if (!account.configured) {
        logger.warn(`account ${id} 未配置 token，跳过`);
        continue;
      }
      const ac = new AbortController();
      const monitor = monitorWeixinAccount({
        account,
        onMessage,
        abortSignal: ac.signal,
      });
      monitor.catch((err) => logger.error(`monitor ${id} crashed: ${String(err)}`));
      stopFns.push(() => ac.abort());
    } catch (err) {
      logger.error(`resolve account ${id} failed: ${String(err)}`);
    }
  }
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      for (const stop of stopFns) stop();
    }, { once: true });
  }
  return () => {
    for (const stop of stopFns) stop();
  };
}
