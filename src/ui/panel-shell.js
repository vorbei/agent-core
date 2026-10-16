// The side panel's shell around the chat: the header (the Chat control that opens the thread list,
// the "…" menu that switches to the product's other views) and which view is shown. Plain DOM
// markup and listeners, so a shell written as HTML strings and one written in React both use it;
// its styles are ui/panel.css. From X Gardener sidepanel/panel.js (its toolbar).

const MORE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';
const CHEVRON_ICON = '<svg class="chat-panel-chat-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>';

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

/**
 * The header's markup. With `lead` (an account header) the Chat control follows it; without, the
 * Chat control leads, followed by `status`. Labels are escaped; `lead`, `status`, icons, `extra`
 * (more menu entries after the views) and `note` (the menu's last line) are the product's markup.
 * @param {{ lead?: string, status?: string,
 *   chat: { label?: string, triggerId: string, menuId: string },
 *   more: { label: string, items: { view: string, label: string, icon?: string }[], extra?: string, note?: string } }} options
 */
export function panelHeaderMarkup({ lead = "", status = "", chat, more }) {
  // The control reads the open chat's title (the chat fills [data-chat-title]) while the chat is
  // shown, and its label otherwise or while the chat has no title.
  const control = `<div class="chat-panel-chat"><button id="${escapeHtml(chat.triggerId)}" class="chat-panel-tab is-active" data-view="chat" role="tab" aria-selected="true" aria-haspopup="menu" aria-expanded="false"><span class="chat-panel-chat-title" data-chat-title></span><span class="chat-panel-chat-label">${escapeHtml(chat.label || "Chat")}</span>${CHEVRON_ICON}</button><div id="${escapeHtml(chat.menuId)}" class="chat-panel-chat-menu"></div></div>`;
  const items = more.items.map(({ view, label, icon = "" }) => `<button data-view="${escapeHtml(view)}" role="tab" aria-selected="false"><span class="chat-panel-menu-icon" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span></button>`).join("");
  const menu = `<details class="chat-panel-more"><summary data-more-trigger aria-label="${escapeHtml(more.label)}">${MORE_ICON}</summary><div class="chat-panel-popover chat-panel-more-options">${items}${more.extra || ""}${more.note ? `<p class="chat-panel-menu-note">${more.note}</p>` : ""}</div></details>`;
  return lead
    ? `<div class="chat-panel-header">${lead}\n      ${control}\n      ${menu}</div>`
    : `<div class="chat-panel-header is-chat-first"><div class="chat-panel-lead">${control}${status}</div>\n      ${menu}</div>`;
}

/**
 * Wires a header: a click on a view's control calls `onView(view)`; one menu of the header is open
 * at a time, and an open one closes on a pointer outside it or on Escape. Returns the unbind.
 * @param {Element} header
 * @param {{ onView(view: string): void }} options
 */
export function bindPanelHeader(header, { onView }) {
  const menus = [...header.querySelectorAll("details")];
  const isOpen = (menu) => menu.hasAttribute("open");
  const close = (menu) => menu.removeAttribute("open");
  const click = (event) => {
    const control = event.target.closest?.("[data-view]");
    if (control && header.contains(control)) onView(control.dataset.view);
  };
  const toggles = menus.map((menu) => () => { if (isOpen(menu)) for (const other of menus) if (other !== menu) close(other); });
  const outside = (event) => { for (const menu of menus) if (isOpen(menu) && !menu.contains(event.target)) close(menu); };
  const escape = (event) => {
    if (event.key !== "Escape") return;
    for (const menu of menus) if (isOpen(menu)) { close(menu); menu.querySelector("summary")?.focus(); }
  };
  const doc = header.ownerDocument;
  header.addEventListener("click", click);
  menus.forEach((menu, index) => menu.addEventListener("toggle", toggles[index]));
  doc.addEventListener("pointerdown", outside);
  doc.addEventListener("keydown", escape);
  return () => {
    header.removeEventListener("click", click);
    menus.forEach((menu, index) => menu.removeEventListener("toggle", toggles[index]));
    doc.removeEventListener("pointerdown", outside);
    doc.removeEventListener("keydown", escape);
  };
}

/**
 * Marks `view` as the shown one in the header: its control selected, the "…" menu closed and its
 * trigger marked while a view other than the chat is shown. The product shows and hides its views.
 * @param {Element} header
 * @param {string} view
 */
export function markPanelView(header, view) {
  for (const control of header.querySelectorAll("[data-view]")) {
    const active = control.dataset.view === view;
    control.classList.toggle("is-active", active);
    control.setAttribute("aria-selected", String(active));
  }
  header.querySelector(".chat-panel-more")?.removeAttribute("open");
  header.querySelector("[data-more-trigger]")?.classList.toggle("is-active", view !== "chat");
}
