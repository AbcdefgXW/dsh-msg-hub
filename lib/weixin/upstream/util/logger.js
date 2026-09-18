/**
 * logger.js — 上游 openclaw-weixin 的 logger 适配层
 *
 * 官方实现用 logger.debug/info/warn/error；这里转发到 dsh-msg-hub 的诊断日志，
 * 使 upstream/ 下的代码保持原样，便于跟随上游更新（debug 级别默认丢弃，过于啰嗦）。
 */
import { diagLog } from "../../../diag.js";

export const logger = {
  debug: () => {},
  info: (m) => diagLog(`[wx-upstream] ${m}`),
  warn: (m) => diagLog(`[wx-upstream] WARN ${m}`),
  error: (m) => diagLog(`[wx-upstream] ERROR ${m}`),
};
