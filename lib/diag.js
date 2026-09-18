/**
 * diag.js — 诊断日志（写入 dsh-msg-hub state/logs/bridge-debug.log）
 *
 * 内置轮转与清理，避免日志无限增长：
 *   - bridge-debug.log 超过上限时改名为 .1，旧的依次后移，只保留 KEEP 份；
 *   - 每日日志 dsh-msg-hub-YYYY-MM-DD.log 超过保留天数的自动删除（每天最多清一次）。
 * 全部为 best-effort：任何异常都不会中断调用方的业务流程。
 *
 * 可用环境变量覆盖默认值：
 *   DSH_MSG_HUB_LOG_MAX_BYTES  单文件上限（默认 5 MiB）
 *   DSH_MSG_HUB_LOG_KEEP       保留历史份数（默认 3）
 *   DSH_MSG_HUB_LOG_KEEP_DAYS  每日日志保留天数（默认 14）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = path.join(PLUGIN_ROOT, "state", "logs");
const LOG_NAME = "bridge-debug.log";

/** 正整数解析（非法值回落到默认值）。 */
function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 单个诊断日志大小上限，超过即轮转。 */
const MAX_BYTES = envInt("DSH_MSG_HUB_LOG_MAX_BYTES", 5 * 1024 * 1024);
/** 保留的历史份数（连同当前文件共 KEEP + 1 个）。 */
const KEEP = envInt("DSH_MSG_HUB_LOG_KEEP", 3);
/** 每日日志保留天数。 */
const KEEP_DAYS = envInt("DSH_MSG_HUB_LOG_KEEP_DAYS", 14);
/** 每日日志文件名。 */
const DAILY_RE = /^dsh-msg-hub-\d{4}-\d{2}-\d{2}\.log$/;

/** 超过上限就把当前日志改名归档，并裁掉最旧的一份。 */
function rotateIfNeeded(file) {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
  } catch {
    return;
  }
  try {
    fs.rmSync(`${file}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // best-effort：轮转失败也继续写日志
  }
}

/** 删除超过保留期的每日日志。 */
function cleanupDailyLogs() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(LOG_DIR)) {
      if (!DAILY_RE.test(name)) continue;
      const file = path.join(LOG_DIR, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  } catch {
    // best-effort
  }
}

// 上次执行每日清理的自然日（UTC，YYYY-MM-DD）；每天最多清一次。
let lastCleanupDay = "";

/** 写入一条诊断日志（带轮转）。 */
export function diagLog(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, LOG_NAME);
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`, "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    if (today !== lastCleanupDay) {
      lastCleanupDay = today;
      cleanupDailyLogs();
    }
  } catch {
    // best-effort
  }
}

/** 手动整理日志目录（轮转 + 清理过期每日日志），供启动或维护时调用。 */
export function tidyLogs() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded(path.join(LOG_DIR, LOG_NAME));
    cleanupDailyLogs();
  } catch {
    // best-effort
  }
}
