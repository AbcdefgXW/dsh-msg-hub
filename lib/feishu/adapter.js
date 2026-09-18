/**
 * adapter.js — 飞书适配器（开放平台官方长连接）
 *
 * 用 @larksuiteoapi/node-sdk：
 *   - WSClient 长连接事件订阅（无需公网回调地址）
 *   - EventDispatcher 注册 im.message.receive_v1
 *   - client.im.message.create 回复文本
 *
 * 凭证：state/feishu/accounts.json（scripts/feishu-login.mjs 或 File Station 填写）
 */
import { Client, EventDispatcher, WSClient, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { listFeishuAccounts } from "./credentials.js";
import { diagLog } from "../diag.js";
import { transcribeAudio, isAsrEnabled } from "../asr.js";
import { saveMedia, mediaHint, guessImageExt } from "../media.js";

/** 从消息事件提取文本。 */
export function extractFeishuText(event) {
  try {
    const msg = event?.message;
    if (!msg) return "";
    if (msg.message_type !== "text") return ""; // 图片/文件等暂不处理
    const content = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
    return typeof content?.text === "string" ? content.text.trim() : "";
  } catch {
    return "";
  }
}

/**
 * 从消息事件提取语音资源（message_type === "audio"）。
 * @returns {{fileKey: string, duration: number|null, messageId: string}|null}
 */
export function extractFeishuAudio(event) {
  try {
    const msg = event?.message;
    if (!msg || msg.message_type !== "audio") return null;
    const content = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
    if (!content?.file_key) return null;
    return { fileKey: content.file_key, duration: content.duration ?? null, messageId: msg.message_id };
  } catch {
    return null;
  }
}

/**
 * 从消息事件提取图片资源（message_type === "image"）。
 * @returns {{imageKey: string, messageId: string}|null}
 */
export function extractFeishuImage(event) {
  try {
    const msg = event?.message;
    if (!msg || msg.message_type !== "image") return null;
    const content = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
    if (!content?.image_key) return null;
    return { imageKey: content.image_key, messageId: msg.message_id };
  } catch {
    return null;
  }
}

/**
 * 下载飞书消息资源为 Buffer。
 * @param {string} type "file"（音频/视频/文件）或 "image"
 */
async function downloadFeishuResource(client, messageId, fileKey, type) {
  const res = await client.im.v1.messageResource.get({
    params: { type },
    path: { message_id: messageId, file_key: fileKey },
  });
  const stream = res?.getReadableStream?.();
  if (!stream) return null;
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** 下载飞书语音资源并转写成文字（任何失败都返回空字符串，不影响其它消息）。 */
async function transcribeFeishuVoice(client, audio) {
  try {
    const buf = await downloadFeishuResource(client, audio.messageId, audio.fileKey, "file");
    if (!buf?.length) {
      diagLog("[feishu] 语音下载为空（可能缺少 im:resource 权限）");
      return "";
    }
    diagLog(`[feishu] 语音已下载 ${buf.length} 字节（时长 ${audio.duration ?? "?"}ms），开始转写`);
    return await transcribeAudio(buf, { filename: "voice.opus", mime: "audio/ogg" });
  } catch (e) {
    diagLog(`[feishu] 语音处理失败: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

/** 下载飞书图片并落盘到工作区，返回本地路径（任何失败都返回空字符串）。 */
async function saveFeishuImage(client, image) {
  try {
    const buf = await downloadFeishuResource(client, image.messageId, image.imageKey, "image");
    if (!buf?.length) {
      diagLog("[feishu] 图片下载为空（可能缺少 im:resource 权限）");
      return "";
    }
    const file = saveMedia(buf, { channel: "feishu", ext: guessImageExt(buf) });
    if (file) diagLog(`[feishu] 图片已保存 ${buf.length} 字节: ${file}`);
    return file;
  } catch (e) {
    diagLog(`[feishu] 图片处理失败: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

/**
 * 启动一个飞书应用（长连接）。
 * @param {object} account {appId, appSecret}
 * @param {object} opts
 * @param {(text: string, peerKey: string, event) => Promise<void>} opts.onMessage
 * @returns {Promise<{client, stop: () => void}>}
 */
export async function startFeishuAccount(account, { onMessage }) {
  const client = new Client({
    appId: account.appId,
    appSecret: account.appSecret,
    loggerLevel: LoggerLevel.info,
  });

  const dispatcher = new EventDispatcher({
    loggerLevel: LoggerLevel.error,
  }).register({
    "im.message.receive_v1": async (data) => {
      const event = data?.event ?? data;
      const sender = event?.sender?.sender_id;
      const openId = sender?.open_id ?? sender?.user_id ?? sender?.union_id ?? "";
      if (!openId) return;
      const chatType = event?.message?.chat_type ?? "p2p";
      // 会话键：p2p 用用户 openid；群聊用 chat_id:发送者
      const peerKey = chatType === "group" ? `group:${event.message.chat_id}:${openId}` : `p2p:${openId}`;

      // 文本优先；非文本时依次尝试语音转写、图片识别（其余类型仍不处理）
      let text = extractFeishuText(event);
      if (!text) {
        const audio = extractFeishuAudio(event);
        if (audio) {
          if (!isAsrEnabled()) {
            diagLog(`[feishu ${account.appId}] 收到语音，但未配置 ASR（缺 state/asr.env）已跳过`);
            return;
          }
          text = await transcribeFeishuVoice(client, audio);
          if (!text) {
            diagLog(`[feishu ${account.appId}] 语音转写结果为空，已忽略`);
            return;
          }
        } else {
          const image = extractFeishuImage(event);
          if (!image) return;
          const file = await saveFeishuImage(client, image);
          if (!file) {
            diagLog(`[feishu ${account.appId}] 图片保存失败，已忽略`);
            return;
          }
          // 只把本地路径交给模型，由它自己用 read_image 看图：
          // dsh 原生支持图片输入，纯文本模型也会自动降级，无需预先转成文字。
          text = mediaHint(file);
        }
      }
      diagLog(`[feishu ${account.appId}] 收到消息 ${chatType} from=${openId} text="${text.slice(0, 40)}"`);
      Promise.resolve(onMessage(text, peerKey, event, client)).catch((err) => {
        diagLog(`[feishu ${account.appId}] onMessage 失败: ${String(err)}`);
      });
    },
  });

  const ws = new WSClient({
    appId: account.appId,
    appSecret: account.appSecret,
    loggerLevel: LoggerLevel.error,
    source: "dsh-msg-hub",
  });

  await ws.start({ eventDispatcher: dispatcher });
  diagLog(`[feishu ${account.appId}] 长连接已启动`);
  return { client, stop: () => ws.disconnect() };
}

/** 发送文本消息。 */
/** 发一条消息给用户：优先富文本 post（渲染 markdown），失败回退纯文本。 */
/**
 * 飞书 lark_md 预处理：lark_md 只支持 斜体/加粗/删除线/链接/换行/彩色文本/@人 子集，
 * 代码、代码块、列表、引用、表格均不支持——降级为文本样式（列表→•、引用→▍、代码去反引号、标题→加粗）。
 */
export function mdForFeishu(md) {
  return String(md || "")
    .replace(/\`\`\`[a-zA-Z0-9]*\n([\s\S]*?)\`\`\`/g, "【代码】\n$1")
    .replace(/\`([^\`\n]+)\`/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/^\s*\d+\.\s+/gm, "1. ")
    .replace(/^>\s?/gm, "▍")
    .replace(/^#{1,4}\s+/gm, "**")
    .replace(/^(\*\*[^*\n]+)$/gm, "$1**")
    .replace(/^\s*\|.*\|\s*$/gm, (m) => m.replace(/\|/g, " ｜ ").replace(/---/g, "───"))
    .replace(/^\s*\|\s*$/gm, "");
}

export async function sendFeishuText(client, openId, text) {
  // 飞书消息卡片 + lark_md：lark_md 自动渲染 markdown（粗体/代码/链接/列表/引用/代码块）
  try {
    await client.im.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: openId,
        msg_type: "interactive",
        content: JSON.stringify({
          config: { wide_screen_mode: true },
          elements: [{ tag: "div", text: { tag: "lark_md", content: mdForFeishu(text) } }],
        }),
      },
    });
  } catch (err) {
    diagLog(`[feishu] 卡片发送失败，回退 text: ${String(err).slice(0, 120)}`);
    await client.im.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }
}
/**
 * 启动所有已配置飞书应用。
 * @returns {Promise<{accounts: Map<string, {client, openId?}>, stop: () => void}>}
 */
export async function startFeishuBots({ onMessage }) {
  const accounts = listFeishuAccounts();
  const runtimes = new Map();
  const stops = [];

  for (const account of accounts) {
    try {
      const runtime = await startFeishuAccount(account, { onMessage });
      runtimes.set(account.appId, runtime.client);
      stops.push(runtime.stop);
      diagLog(`[feishu] 应用 ${account.appId} 已启动`);
    } catch (err) {
      diagLog(`[feishu] 应用 ${account.appId} 启动失败: ${String(err)}`);
    }
  }

  return {
    clients: runtimes,
    stop: () => {
      for (const stop of stops) stop();
    },
  };
}
