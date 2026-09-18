/**
 * media.js — 渠道媒体落盘（图片等）
 *
 * 把 IM 渠道收到的图片存成工作区里的本地文件，会话消息只带路径，
 * 由 agent 自己用 read_image 工具查看 —— dsh 原生支持图片输入，
 * 对纯文本模型也会自动降级，因此不需要预先转成文字描述。
 *
 * 存储位置：<工作区根>/.im-media/<渠道>/<YYYY-MM-DD>/<时间戳>-<随机>.<ext>
 * 保留期：默认 7 天，超期文件由本模块在写入时顺带清理（每天最多一次）。
 *
 * 可用环境变量：
 *   DSH_CHANNELS_CWD          工作区根（默认 /workspace）
 *   DSH_MSG_HUB_MEDIA_KEEP_DAYS  媒体保留天数（默认 7）
 */
import fs from "node:fs";
import path from "node:path";
import { diagLog } from "./diag.js";

const WORKSPACE_CWD = process.env.DSH_CHANNELS_CWD?.trim() || "/workspace";
/** 媒体根目录：工作区内，保证 agent 的 read_image 能读到。 */
export const MEDIA_ROOT = path.join(WORKSPACE_CWD, ".im-media");

/** 保留天数（正整数，非法值回落到 7）。 */
function keepDays() {
  const n = Number(process.env.DSH_MSG_HUB_MEDIA_KEEP_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
}

/** 按图片头字节猜扩展名（读不到时用 .jpg）。 */
export function guessImageExt(buf) {
  if (!buf || buf.length < 12) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf.slice(0, 3).toString("ascii") === "GIF") return "gif";
  return "jpg";
}

/** 上次清理的日期（YYYY-MM-DD），每天最多清一次。 */
let lastSweepDay = "";

/** 删除超过保留期的媒体目录（按日期子目录判断）。 */
function sweepOldMedia() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastSweepDay) return;
  lastSweepDay = today;
  try {
    const cutoff = Date.now() - keepDays() * 24 * 60 * 60 * 1000;
    for (const channel of fs.readdirSync(MEDIA_ROOT)) {
      const chDir = path.join(MEDIA_ROOT, channel);
      let dayDirs;
      try {
        dayDirs = fs.readdirSync(chDir);
      } catch {
        continue;
      }
      for (const day of dayDirs) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        if (new Date(`${day}T00:00:00Z`).getTime() >= cutoff) continue;
        try {
          fs.rmSync(path.join(chDir, day), { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // 目录还不存在时忽略
  }
}

/**
 * 把媒体数据存到工作区本地文件。
 * @param {Buffer|Uint8Array} data 文件字节
 * @param {{channel?: string, filename?: string, ext?: string}} [opts]
 * @returns {string} 绝对路径；失败时返回空字符串
 */
export function saveMedia(data, opts = {}) {
  if (!data?.length) return "";
  try {
    const channel = (opts.channel || "unknown").replace(/[^\w.-]/g, "_");
    const ext = (opts.ext || guessImageExt(data)).replace(/^\./, "");
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(MEDIA_ROOT, channel, day);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const rand = Math.random().toString(36).slice(2, 8);
    const file = path.join(dir, `${stamp}-${rand}.${ext}`);
    fs.writeFileSync(file, data);
    sweepOldMedia();
    return file;
  } catch (e) {
    diagLog(`[media] 保存失败: ${e instanceof Error ? e.message : String(e)}`);
    return "";
  }
}

/**
 * 生成给模型看的提示文本：相对工作区路径 + 查看方式。
 * 用相对路径，避免把宿主机绝对路径写进对话。
 */
export function mediaHint(absPath, { kind = "图片" } = {}) {
  const rel = absPath.startsWith(WORKSPACE_CWD)
    ? absPath.slice(WORKSPACE_CWD.length).replace(/^[/\\]/, "")
    : absPath;
  return `[用户发来一张${kind}，已保存到工作区：${rel}。请用 read_image 工具查看这张${kind}后再回答。]`;
}
