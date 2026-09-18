/**
 * vision.js — 图片识别（SiliconFlow 视觉模型）
 *
 * 把渠道图片消息转成文字描述，供 IM 桥接复用：
 * 底层文本模型没有原生识图能力，必须先由视觉模型转成文字再进会话。
 *
 * 凭据来源（按优先级）：
 *   1. 环境变量 DSH_MSG_HUB_VISION_KEY
 *   2. <插件根>/state/vision.env 的 DASHSCOPE_API_KEY
 *   3. <插件根>/state/asr.env   的 DASHSCOPE_API_KEY（与语音转写共用同一个 key）
 * 都取不到时 isVisionEnabled() 为 false，渠道侧跳过图片、保持原有行为。
 *
 * 可用环境变量：
 *   DSH_MSG_HUB_VISION_KEY    API key（优先级最高）
 *   DSH_MSG_HUB_VISION_BASE   API 基址（默认 https://api.siliconflow.cn/v1）
 *   DSH_MSG_HUB_VISION_MODEL  视觉模型（默认 Qwen/Qwen3-VL-30B-A3B-Instruct）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diagLog } from "./diag.js";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VISION_ENV_FILE = path.join(PLUGIN_ROOT, "state", "vision.env");
const ASR_ENV_FILE = path.join(PLUGIN_ROOT, "state", "asr.env");

const DEFAULT_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_MODEL = "Qwen/Qwen3-VL-30B-A3B-Instruct";
/** 默认提问：描述 + 文字转录，兼顾"看图"与"读图"。 */
const DEFAULT_PROMPT = "请用中文描述这张图片的内容；如果图中有文字，请完整转录出来。";
/** 单次识别超时（毫秒）。 */
const TIMEOUT_MS = 60_000;

/** 读 KEY=VALUE 形式的 .env。 */
function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch {
    // 文件不存在时跳过
  }
  return out;
}

/** 解析视觉配置（每次调用读取，改配置后无需重启）。 */
export function getVisionConfig() {
  const visionEnv = readEnvFile(VISION_ENV_FILE);
  const asrEnv = readEnvFile(ASR_ENV_FILE);
  const key =
    process.env.DSH_MSG_HUB_VISION_KEY?.trim() ||
    visionEnv.DASHSCOPE_API_KEY ||
    asrEnv.DASHSCOPE_API_KEY ||
    "";
  const base = (
    process.env.DSH_MSG_HUB_VISION_BASE?.trim() ||
    visionEnv.DASHSCOPE_BASE_URL?.trim() ||
    asrEnv.DASHSCOPE_BASE_URL?.trim() ||
    DEFAULT_BASE
  ).replace(/\/+$/, "");
  const model =
    process.env.DSH_MSG_HUB_VISION_MODEL?.trim() ||
    visionEnv.VISION_MODEL?.trim() ||
    DEFAULT_MODEL;
  return { key, base, model, enabled: Boolean(key) };
}

/** 是否已配置凭据（未配置时渠道侧跳过图片处理）。 */
export function isVisionEnabled() {
  return getVisionConfig().enabled;
}

/** 由文件名/类型猜 MIME（视觉接口需要正确的 data URL 头）。 */
function guessMime(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      bmp: "image/bmp",
    }[ext] || "image/jpeg"
  );
}

/**
 * 把图片识别成文字。
 * @param {Buffer|Uint8Array} image 图片字节
 * @param {{filename?: string, prompt?: string}} [opts]
 * @returns {Promise<string>} 识别文本；未配置凭据或失败时返回空字符串
 */
export async function describeImage(image, opts = {}) {
  const cfg = getVisionConfig();
  if (!cfg.enabled || !image?.length) return "";
  const mime = guessMime(opts.filename || "image.jpg");
  const prompt = opts.prompt || DEFAULT_PROMPT;
  try {
    const res = await fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${Buffer.from(image).toString("base64")}` },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      diagLog(`[vision] 识别失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return "";
    }
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content;
    const out = typeof text === "string" ? text.trim() : "";
    if (out) diagLog(`[vision] 识别成功（${image.length} 字节）: "${out.slice(0, 40)}"`);
    return out;
  } catch (e) {
    diagLog(`[vision] 识别异常: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}
