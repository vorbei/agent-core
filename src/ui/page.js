// A page over the side panel's shown view (the Routine editor, Minify's Persona, a secret's form):
// it covers the view, with no backdrop, under a head with a back button, the view it came from and
// its title. Plain DOM markup, like the panel shell; its styles are ui/panel.css (.chat-page*).
// The opener keeps the page's open state: it focuses the title on open (focusPageTitle) and, on
// back or Escape, returns focus to the control that opened it.

const BACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

/**
 * The page's head. `title` and `from` (the view it covers) are escaped; `back.attrs` (what the
 * back button does, e.g. a data attribute) and `controls` (buttons at the right) are the caller's
 * markup.
 * @param {{ title: string, from?: string, titleId?: string, back: { label: string, attrs?: string }, controls?: string }} options
 */
export function pageHeadMarkup({ title, from = "", titleId = "", back, controls = "" }) {
  return `<header class="chat-page-head"><button type="button" class="chat-page-back" ${back.attrs || ""} aria-label="${escapeHtml(back.label)}" title="${escapeHtml(back.label)}">${BACK_ICON}</button><div class="chat-page-title">${from ? `<small>${escapeHtml(from)}</small>` : ""}<h2${titleId ? ` id="${escapeHtml(titleId)}"` : ""} tabindex="-1">${escapeHtml(title)}</h2></div>${controls ? `<div class="chat-page-controls">${controls}</div>` : ""}</header>`;
}

/**
 * Moves focus to an open page's title, so a screen reader starts there.
 * @param {Element | null | undefined} page
 */
export function focusPageTitle(page) {
  /** @type {HTMLElement | null | undefined} */ (page?.querySelector(".chat-page-title h2"))?.focus({ preventScroll: true });
}
