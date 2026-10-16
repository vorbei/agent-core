// Where the agent's own tabs live, how a background tab is readied for input, and which tabs an
// action opened. The agent's tabs go to one normal, unfocused window, so opening one never changes
// the user's current window, tab or OS focus (or, when the host asks, to a window the user works
// in); tabs the user handed over stay where they are.
// From X Gardener src/browser/agent-window.js, input-focus.js and agent/popup-wait.js.

/** @typedef {import("./index.js").ChromeApi} ChromeApi */
/** @typedef {import("./index.js").AgentWindowConfig} AgentWindowConfig */
/** @typedef {import("./index.js").Send} Send */

const NEW_TAB_LOAD_MS = 5_000;
const VISIBLE_WAIT_MS = 1_000;
const VISIBILITY_PROBE_MS = 1_000;
/** @type {WeakMap<object, Promise<number>>} */
const creating = new WeakMap();

/**
 * The remembered agent window id alone, without asking Chrome (usable while that window closes).
 * @param {ChromeApi} api @param {AgentWindowConfig} config
 */
export async function rememberedAgentWindowId(api, config) {
  const id = (await Promise.resolve(api.storage?.session?.get?.(config.storageKey)).catch(() => null))?.[config.storageKey];
  return Number.isInteger(id) ? /** @type {number} */ (id) : null;
}

/**
 * The agent window, if it still exists. `storage.session` survives a worker restart but not an
 * extension reload, so with a group title configured, a window already holding the agent's group
 * is adopted before a new one is made; a window the user closed is forgotten.
 * @param {ChromeApi} api @param {AgentWindowConfig} config
 */
export async function agentWindowId(api, config) {
  const id = await rememberedAgentWindowId(api, config);
  if (id !== null && await api.windows?.get(id).then(() => true, () => false)) return id;
  return adoptAgentWindow(api, config);
}

/**
 * Deterministic: a window with the current group title wins over a legacy one, then the lowest
 * id. Other candidates are left alone; nothing is ever closed.
 * @param {ChromeApi} api @param {AgentWindowConfig} config @returns {Promise<number | null>}
 */
async function adoptAgentWindow(api, config) {
  if (!config.groupTitle || !api.tabGroups?.query || !api.windows) return null;
  const legacy = config.legacyGroupTitles ?? [];
  const groups = await api.tabGroups.query({}).catch(() => []);
  const rank = (/** @type {chrome.tabGroups.TabGroup} */ group) => group.title === config.groupTitle ? 0 : legacy.includes(group.title ?? "") ? 1 : null;
  const candidates = groups.filter(group => rank(group) !== null)
    .sort((a, b) => /** @type {number} */ (rank(a)) - /** @type {number} */ (rank(b)) || a.windowId - b.windowId);
  for (const { windowId } of candidates) {
    const window = await api.windows.get(windowId).catch(() => null);
    if (!window || (window.type && window.type !== "normal")) continue;
    await api.storage?.session?.set?.({ [config.storageKey]: windowId });
    for (const group of groups) {
      if (group.windowId === windowId && rank(group) === 1) await api.tabGroups.update(group.id, { title: config.groupTitle }).catch(() => {});
    }
    return windowId;
  }
  return null;
}

/**
 * Opens a tab for the agent in its own window. The tab is `active` in that window by default, so
 * Chrome renders it and delivers input promptly. Without a windows API (tests, minimal hosts) it
 * is a tab in the current window. With `windowId` (a window the user works in), the tab opens there
 * instead, right after that window's active tab with it as the opener, ungrouped; the window is
 * never focused, and whether the new tab becomes the shown one is the caller's `active`.
 * @param {ChromeApi} api @param {{ url: string, active?: boolean, windowId?: number }} tab @param {AgentWindowConfig} config
 * @returns {Promise<chrome.tabs.Tab>}
 */
export async function createAgentTab(api, { url, active = true, windowId: userWindowId }, config) {
  if (userWindowId !== undefined) {
    const [current] = await api.tabs.query({ windowId: userWindowId, active: true }).catch(() => []);
    const place = current?.id !== undefined ? { index: current.index + 1, openerTabId: current.id } : {};
    return api.tabs.create({ windowId: userWindowId, url, active, ...place });
  }
  if (!api.windows?.create) return api.tabs.create({ url, active });
  const windowId = await agentWindowId(api, config);
  const tab = windowId !== null ? await api.tabs.create({ windowId, url, active }) : await createAgentWindow(api, url, active, config);
  await groupAgentTab(api, tab, config);
  return tab;
}

/**
 * Serialized so two concurrent opens make one window, not two. `focused: false` with state
 * normal: a minimized window would be hidden and throttled.
 * @param {ChromeApi} api @param {string} url @param {boolean} active @param {AgentWindowConfig} config
 * @returns {Promise<chrome.tabs.Tab>}
 */
async function createAgentWindow(api, url, active, config) {
  const windows = /** @type {typeof chrome.windows} */ (api.windows);
  const inFlight = creating.get(api);
  if (inFlight) {
    const windowId = await inFlight.catch(() => null);
    if (windowId !== null) return api.tabs.create({ windowId, url, active });
  }
  const pending = windows.create({ url, focused: false, state: "normal", type: "normal" });
  creating.set(api, pending.then(window => /** @type {number} */ (window?.id)));
  try {
    const window = /** @type {chrome.windows.Window} */ (await pending);
    await api.storage?.session?.set?.({ [config.storageKey]: window.id });
    return window.tabs?.[0] ?? (await api.tabs.query({ windowId: window.id }))[0];
  } finally { creating.delete(api); }
}

/**
 * Grouping is presentation only: a failure never fails the open.
 * @param {ChromeApi} api @param {chrome.tabs.Tab} tab @param {AgentWindowConfig} config
 */
async function groupAgentTab(api, tab, config) {
  if (!config.groupTitle || !api.tabs.group || !api.tabGroups) return;
  const legacy = config.legacyGroupTitles ?? [];
  try {
    const groups = await api.tabGroups.query({ windowId: tab.windowId });
    const existing = groups.find(group => group.title === config.groupTitle) || groups.find(group => legacy.includes(group.title ?? ""));
    if (existing) {
      await api.tabs.group({ groupId: existing.id, tabIds: [/** @type {number} */ (tab.id)] });
      if (existing.title !== config.groupTitle) await api.tabGroups.update(existing.id, { title: config.groupTitle });
      return;
    }
    const groupId = await api.tabs.group({ tabIds: [/** @type {number} */ (tab.id)], createProperties: { windowId: tab.windowId } });
    await api.tabGroups.update(groupId, { title: config.groupTitle, ...(config.groupColor ? { color: config.groupColor } : {}) });
  } catch { /* An ungrouped agent tab still works. */ }
}

/**
 * Brings a background tab to the front of its window before input: Chrome throttles hidden tabs,
 * and input to them is acknowledged late (seconds) or a wheel scroll times out. The window is not
 * focused; the page sees focus through CDP focus emulation (skipped with `emulateFocus: false`,
 * for a caller that already enabled it on this attachment). Returns once the page reports it is
 * visible, or reports something other than hidden (unknown is not hidden), or after `settleMs` of
 * reporting hidden; each probe is bounded by `probeMs`. The result says what the page reported
 * last (a hidden page's input may be throttled, so a caller can weigh its acknowledgements) and
 * whether focus emulation was turned on by this call.
 * @param {ChromeApi} api @param {chrome.tabs.Tab} tab @param {Send} send @param {(ms: number) => Promise<void>} sleep
 * @param {{ emulateFocus?: boolean, settleMs?: number, probeMs?: number }} [options]
 * @returns {Promise<{ visibility: "visible" | "hidden" | null, focusEmulation: boolean }>}
 */
export async function prepareInput(api, tab, send, sleep, { emulateFocus = true, settleMs = VISIBLE_WAIT_MS, probeMs = VISIBILITY_PROBE_MS } = {}) {
  if (!tab.active) await api.tabs.update(/** @type {number} */ (tab.id), { active: true });
  const focusEmulation = emulateFocus && await send("Emulation.setFocusEmulationEnabled", { enabled: true }).then(() => true, () => false);
  for (let waited = 0; ; waited += 50) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const state = await Promise.race([
      send("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true, silent: true }).then(result => result?.result?.value, () => null),
      new Promise(resolve => { timer = setTimeout(resolve, probeMs, null); }),
    ]).finally(() => clearTimeout(timer));
    if (state !== "hidden" || waited >= settleMs) return { visibility: state === "hidden" || state === "visible" ? state : null, focusEmulation };
    await sleep(50);
  }
}

/**
 * Starts collecting tabs created during an action; `stop` returns them once loaded (or after a
 * bound). Any tab born during the action counts, not only those whose openerTabId is the acting
 * tab: measured in Chrome, a page in a background tab that calls window.open gets the window's
 * active tab as the new tab's opener.
 * @param {ChromeApi} api @param {(ms: number) => Promise<void>} sleep
 */
export function watchOpenedTabs(api, sleep) {
  /** @type {number[]} */
  const ids = [];
  const created = (/** @type {chrome.tabs.Tab} */ tab) => { if (tab.id !== undefined && !tab.incognito) ids.push(tab.id); };
  api.tabs.onCreated.addListener(created);
  return {
    /** @returns {Promise<chrome.tabs.Tab[]>} */
    async stop() {
      api.tabs.onCreated.removeListener(created);
      const tabs = [];
      for (const id of ids) {
        let tab = await api.tabs.get(id).catch(() => null);
        for (let waited = 0; tab && tab.status !== "complete" && waited < NEW_TAB_LOAD_MS; waited += 250) {
          await sleep(250);
          tab = await api.tabs.get(id).catch(() => null);
        }
        if (tab) tabs.push(tab);
      }
      return tabs;
    },
  };
}

/** One sentence per opened tab for an action's result. @param {chrome.tabs.Tab[]} tabs */
export function describeOpenedTabs(tabs) {
  return tabs.map(tab => ` Opened new tab tabId=${tab.id} ${JSON.stringify(tab.title ?? "")} ${tab.url || tab.pendingUrl || "(loading)"}${tab.status === "complete" ? "" : " (still loading)"}.`).join("");
}
