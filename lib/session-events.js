/**
 * session-events.js — 会话事件数组的兼容读取（dsh Session API 变更适配）
 *
 * 背景：dsh 0.1.5-rc.2 的 Session 类不再暴露公开 `events` 属性（内部改为私有
 * eventsSnapshot 缓存），只提供方法：
 *   - snapshotEvents(fromSeq?, toSeqExclusive?) → readonly SessionEvent[]（默认全量）
 *   - ownEvents() → 排除 fork 继承前缀的子事件
 *   - eventAt(seq) / get seq()
 * 旧版 dsh（或带兼容包装的 session 对象）仍可能是 `session.events` 数组属性。
 *
 * 统一取法：优先 snapshotEvents()，回退 `events`（数组或任意可迭代），都取不到返回空数组。
 * 这样两条 API 路径都不会抛 "events is not iterable"，也不会因属性消失而静默失效。
 *
 * @param {object} session - dsh session 对象（或带 events 属性的兼容对象）
 * @param {number} [fromSeq] - 可选起始 seq（新版 API 走切片，长会话更省；旧版属性忽略此参数，由调用方自行过滤）
 * @returns {readonly object[]} 事件数组（取不到时为空数组）
 */
export function sessionEvents(session, fromSeq) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") {
      const evs = fromSeq === undefined ? session.snapshotEvents() : session.snapshotEvents(fromSeq);
      if (Array.isArray(evs)) return evs;
    }
  } catch {
    // snapshotEvents 抛错时继续走旧属性回退
  }
  const raw = session.events;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw[Symbol.iterator] === "function") {
    try {
      return [...raw];
    } catch {
      // 不可展开则视为取不到
    }
  }
  return [];
}
