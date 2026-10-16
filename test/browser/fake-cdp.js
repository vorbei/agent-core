// A scripted CDP `send` for unit tests: answers by method (and session) from handlers, and records
// every command it receives.

/**
 * @param {Record<string, (params: any, sessionId?: string) => any>} handlers
 * @param {string[]} [sessions] cross-process iframe sessions
 */
export function fakeSend(handlers, sessions = []) {
  /** @type {{ method: string, params?: any, sessionId?: string }[]} */
  const sent = [];
  const send = Object.assign(async (/** @type {string} */ method, /** @type {any} */ params, /** @type {string | undefined} */ sessionId) => {
    sent.push({ method, params, sessionId });
    const handler = handlers[`${method}@${sessionId ?? ""}`] ?? handlers[method];
    if (!handler) return {};
    const value = await handler(params, sessionId);
    if (value instanceof Error) throw value;
    return value;
  }, { iframeSessions: async () => sessions });
  return { send, sent };
}

/** A tiny event source with Chrome's addListener/removeListener shape. */
export function eventSource() {
  /** @type {Set<Function>} */
  const listeners = new Set();
  return {
    addListener: (/** @type {Function} */ fn) => listeners.add(fn),
    removeListener: (/** @type {Function} */ fn) => listeners.delete(fn),
    emit: (/** @type {any[]} */ ...args) => { for (const fn of [...listeners]) fn(...args); },
    get size() { return listeners.size; },
  };
}
