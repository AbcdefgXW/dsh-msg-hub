/**
 * asr.js — 语音转写（SiliconFlow SenseVoiceSmall）
 *
 * 把渠道语音消息的音频数据转成文字，供 IM 桥接复用。
 *
 * 凭据来源（按优先级）：
 *   1. 环境变量 DSH_MSG_HUB_ASR_KEY
 *   2. <插件根>/state/asr.env 里的 DASHSCOPE_API_KEY
 * 未配置凭据时 isAsrEnabled() 返回 false，渠道侧跳过语音、保持原有行为。
 *
 * 可用环境变量：
 *   DSH_MSG_HUB_ASR_KEY    API key（优先级最高）
 *   DSH_MSG_HUB_ASR_BASE   API 基址（默认 https://api.siliconflow.cn/v1）
 *   DSH_MSG_HUB_ASR_MODEL  模型（默认 FunAudioLLM/SenseVoiceSmall）
 *
 * 注意：SenseVoiceSmall 走现金计费（不在兑换券范围内），仅用于语音消息，请勿高频调用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diagLog } from "./diag.js";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASR_ENV_FILE = path.join(PLUGIN_ROOT, "state", "asr.env");

const DEFAULT_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "FunAudioLLM/SenseVoiceSmall";
/** 单次转写超时（毫秒）。实测偶发超过 60s（网络/服务端抖动），故放宽到 120s。 */
const TIMEOUT_MS = 120_000;

/** 读 state/asr.env（KEY=VALUE 行，支持 # 注释）。 */
function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ASR_ENV_FILE, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch {
    // 无配置文件时仅用环境变量
  }
  return out;
}

/** 解析 ASR 配置（每次调用时读取，改配置后无需重启）。 */
export function getAsrConfig() {
  const file = readEnvFile();
  const key = process.env.DSH_MSG_HUB_ASR_KEY?.trim() || file.DASHSCOPE_API_KEY || "";
  const base = (
    process.env.DSH_MSG_HUB_ASR_BASE?.trim() ||
    file.DASHSCOPE_BASE_URL?.trim() ||
    DEFAULT_BASE
  ).replace(/\/+$/, "");
  const model =
    process.env.DSH_MSG_HUB_ASR_MODEL?.trim() || file.DSH_MSG_HUB_ASR_MODEL?.trim() || DEFAULT_MODEL;
  return { key, base, model, enabled: Boolean(key) };
}

/** 是否已配置凭据（未配置时渠道侧跳过语音处理）。 */
export function isAsrEnabled() {
  return getAsrConfig().enabled;
}

/**
 * 把音频数据转成文字。
 * @param {Buffer|Uint8Array} audio 音频字节
 * @param {{filename?: string, mime?: string}} [opts]
 * @returns {Promise<string>} 转写文本；未配置凭据或失败时返回空字符串
 */
export async function transcribeAudio(audio, opts = {}) {
  const cfg = getAsrConfig();
  if (!cfg.enabled || !audio?.length) return "";
  const filename = opts.filename || "voice.opus";
  const mime = opts.mime || "audio/ogg";
  try {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: mime }), filename);
    form.append("model", cfg.model);
    const res = await fetch(`${cfg.base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      diagLog(`[asr] 转写失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return "";
    }
    const j = await res.json();
    const text = typeof j?.text === "string" ? j.text.trim() : "";
    if (text) diagLog(`[asr] 转写成功（${j?.usage?.seconds ?? "?"} 秒）: "${text.slice(0, 40)}"`);
    return text;
  } catch (e) {
    diagLog(`[asr] 转写异常: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}
