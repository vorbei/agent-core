// A chrome.debugger connection per tab: one attachment per tab, commands serialized per tab, a
// timeout on every command, an idle detach (so Chrome's "started debugging this browser" bar does
// not stay up), an optional method allowlist, and cross-process iframes (OOPIFs) reached through
// flattened child sessions that Target.setAutoAttach creates on the same attachment.
import { BrowserCoreError } from "./errors.js";

const DEFAULTS = { commandTimeoutMs: 8_000, idleDetachMs: 30_000, childSetupMs: 3_000 };
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }, { exclude: true }] };

/** @typedef {import("./index.js").ChromeApi} ChromeApi */
/** @typedef {import("./index.js").CdpConfig} CdpConfig */
/** @typedef {import("./index.js").Send} Send */
/** @typedef {{ autoAttached: boolean, sessions: Set<string>, setups: Set<Promise<unknown>> }} Connection */
/** @typedef {{ connections: Map<number, Connection>, queues: Map<number, Promise<unknown>>, idleTimers: Map<number, ReturnType<typeof setTimeout>> }} Client */

/** @type {WeakMap<object, Client>} */
const clients = new WeakMap();

/** @param {ChromeApi} api @param {Required<CdpConfig>} config */
function client(api, config) {
  let state = clients.get(api);
  if (state) return state;
  /** @type {Client} */
  const created = { connections: new Map(), queues: new Map(), idleTimers: new Map() };
  clients.set(api, created);
  const { connections, idleTimers } = created;
  api.debugger.onDetach.addListener(source => { if (source.tabId !== undefined) connections.delete(source.tabId); });
  api.tabs.onRemoved.addListener(tabId => { connections.delete(tabId); clearTimeout(idleTimers.get(tabId)); });
  api.debugger.onEvent.addListener((source, method, params) => {
    const connection = source.tabId === undefined ? undefined : connections.get(source.tabId);
    const event = /** @type {{ sessionId?: string, targetInfo?: { type?: string } } | undefined} */ (params);
    if (!connection || !event?.sessionId) return;
    if (method === "Target.detachedFromTarget") connection.sessions.delete(event.sessionId);
    if (method !== "Target.attachedToTarget" || event.targetInfo?.type !== "iframe") return;
    const sessionId = event.sessionId;
    connection.sessions.add(sessionId);
    // A nested cross-process iframe attaches to its parent's session, not to the root.
    const setup = sendCommand(api, config, connection, /** @type {number} */ (source.tabId), "Target.setAutoAttach", AUTO_ATTACH, sessionId)
      .catch(() => {}).finally(() => connection.setups.delete(setup));
    connection.setups.add(setup);
  });
  return created;
}

/**
 * Runs `work` with the tab attached; calls on one tab never interleave. The connection is cached
 * and detached after `idleDetachMs` without work.
 * @template T
 * @param {ChromeApi} api @param {number} tabId @param {(send: Send) => Promise<T>} work @param {CdpConfig} [options]
 * @returns {Promise<T>}
 */
export function withTab(api, tabId, work, options = {}) {
  const config = /** @type {Required<CdpConfig>} */ ({ allowedMethods: null, ...DEFAULTS, ...options });
  const { connections, queues, idleTimers } = client(api, config);
  const previous = queues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    clearTimeout(idleTimers.get(tabId));
    let connection = connections.get(tabId);
    if (!connection) {
      try { await api.debugger.attach({ tabId }, "1.3"); }
      catch (error) {
        throw new BrowserCoreError("BROWSER_ATTACH_FAILED", `Cannot control tab ${tabId}: ${/** @type {Error} */ (error).message}. Another debugger (DevTools) may be attached, or the page is not controllable.`);
      }
      connection = { autoAttached: false, sessions: new Set(), setups: new Set() };
      connections.set(tabId, connection);
    }
    const current = connection;
    const send = /** @type {Send} */ (Object.assign(
      /** @param {string} method @param {Record<string, unknown>} [params] @param {string} [sessionId] */
      (method, params, sessionId) => sendCommand(api, config, current, tabId, method, params, sessionId),
      { iframeSessions: () => iframeSessions(api, config, current, tabId) }));
    try {
      return await work(send);
    } finally {
      const timer = setTimeout(() => {
        if (connections.get(tabId) !== current) return;
        connections.delete(tabId);
        void api.debugger.detach({ tabId }).catch(() => {});
      }, config.idleDetachMs);
      /** @type {any} */ (timer).unref?.();
      idleTimers.set(tabId, timer);
    }
  });
  queues.set(tabId, next);
  void next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}

/** @param {ChromeApi} api @param {Required<CdpConfig>} config @param {Connection} connection @param {number} tabId */
async function iframeSessions(api, config, connection, tabId) {
  if (!connection.autoAttached) {
    await sendCommand(api, config, connection, tabId, "Target.setAutoAttach", AUTO_ATTACH);
    connection.autoAttached = true;
  }
  // Nested auto-attachments can add another setup while a parent settles.
  const deadline = Date.now() + config.childSetupMs;
  while (connection.setups.size && Date.now() < deadline) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    await Promise.race([Promise.allSettled([...connection.setups]), new Promise(resolve => { timer = setTimeout(resolve, deadline - Date.now()); })]);
    clearTimeout(timer);
  }
  return [...connection.sessions];
}

/**
 * @param {ChromeApi} api @param {Required<CdpConfig>} config @param {Connection} connection @param {number} tabId
 * @param {string} method @param {Record<string, unknown>} [params] @param {string} [sessionId]
 * @returns {Promise<any>}
 */
async function sendCommand(api, config, connection, tabId, method, params, sessionId) {
  if (config.allowedMethods && !config.allowedMethods.has(method)) throw new BrowserCoreError("CDP_METHOD_BLOCKED", `${method} is not an allowed CDP method`);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      api.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new BrowserCoreError("BROWSER_CDP_TIMEOUT", `${method} timed out; a native dialog may be blocking the page`)), config.commandTimeoutMs); }),
    ]);
  } catch (error) {
    const message = String(/** @type {Error} */ (error)?.message);
    if (!sessionId && /not attached/i.test(message)) {
      const { connections } = client(api, config);
      if (connections.get(tabId) === connection) connections.delete(tabId);
      throw new BrowserCoreError("BROWSER_DETACHED", "The debugger was detached (the user may have pressed Cancel); the command was not replayed");
    }
    if (sessionId && /no session|session with given id|not attached|not found/i.test(message)) {
      connection.sessions.delete(sessionId);
      throw new BrowserCoreError("FRAME_GONE", "The iframe's process went away (it navigated or was removed); take a fresh snapshot");
    }
    throw error;
  } finally { clearTimeout(timer); }
}
