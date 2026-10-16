// observeScroll moves what a person's wheel would move. A tiny laid-out DOM stands in for the page:
// each element has a box, overflow and scroll geometry; scrollBy clamps like Chrome does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { observeScroll } from "../../src/browser/index.js";

/** @param {string} selector @param {any} el */
function matches(selector, el) {
  return selector.split(",").some(part => {
    const [, tag, rest] = part.trim().match(/^([a-z]*)(.*)$/) ?? [];
    if (tag && el.localName !== tag) return false;
    if (rest === ":modal") return Boolean(el.modal);
    if (rest === "[open]") return el.attributes.open !== undefined;
    const [, name, value] = rest.match(/^\[([\w-]+)=([\w-]+)\]$/) ?? [];
    return name !== undefined && el.attributes[name] === value;
  });
}

/** @param {string} localName @param {any} [options] @param {any[]} [children] */
function el(localName, options = {}, children = []) {
  const node = {
    localName, attributes: options.attributes ?? {}, children, parentElement: null, modal: false,
    style: { overflowX: "visible", overflowY: options.overflowY ?? "visible" },
    width: options.width ?? 600, height: options.height ?? 650,
    scrollTop: 0, scrollLeft: 0, scrollHeight: options.scrollHeight ?? options.height ?? 650, scrollWidth: options.width ?? 600,
    get clientHeight() { return this.height; }, get clientWidth() { return this.width; },
    getAttribute(/** @type {string} */ name) { return this.attributes[name] ?? null; },
    getBoundingClientRect() { return { width: this.width, height: this.height }; },
    scrollBy(/** @type {number} */ dx, /** @type {number} */ dy) {
      this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this.scrollTop + dy));
      this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, this.scrollLeft + dx));
    },
    querySelectorAll(/** @type {string} */ selector) {
      /** @type {any[]} */ const found = [];
      const walk = (/** @type {any} */ parent) => { for (const child of parent.children) { if (selector === "*" || matches(selector, child)) found.push(child); walk(child); } };
      walk(this);
      return found;
    },
    closest(/** @type {string} */ selector) { for (let n = this; n; n = n.parentElement) if (matches(selector, n)) return n; return null; },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

/**
 * A page as X shows List members: a tall timeline behind a modal in #layers, the root scroll-locked,
 * a zero-height [role=dialog] wrapper around the aria-modal dialog, whose inner div scrolls.
 * @param {{ locked?: boolean, modal?: boolean }} [options]
 */
function page({ locked = true, modal = true } = {}) {
  const cell = el("div", { attributes: { "data-testid": "UserCell" }, height: 80 });
  const list = el("div", { overflowY: "auto", scrollHeight: 2800 }, [el("div", { height: 2800 }, [cell])]);
  const dialog = el("div", { attributes: { role: "dialog", "aria-modal": "true", "aria-label": "List members" }, overflowY: "hidden" }, [el("div", {}, [list])]);
  const wrapper = el("div", { attributes: { role: "dialog" }, width: 1400, height: 0 }, [el("div", { attributes: { role: "group" }, width: 1400, height: 1400 }, [dialog])]);
  const timeline = el("main", { width: 1400, height: 13000 });
  const body = el("body", { width: 1400, height: 13000 }, modal ? [timeline, el("div", { attributes: { id: "layers" }, height: 0 }, [wrapper])] : [timeline]);
  const html = el("html", { overflowY: locked ? "hidden" : "visible", width: 1400, height: 1400, scrollHeight: 13000 }, [body]);
  const win = {
    document: {
      documentElement: html, body, scrollingElement: html,
      querySelectorAll: (/** @type {string} */ selector) => html.querySelectorAll(selector), getElementById: () => null,
    },
    innerWidth: 1400, innerHeight: 1400,
    get scrollX() { return html.scrollLeft; }, get scrollY() { return html.scrollTop; },
    scrollBy: (/** @type {number} */ dx, /** @type {number} */ dy) => html.scrollBy(dx, dy),
  };
  Object.assign(globalThis, { window: win, getComputedStyle: (/** @type {any} */ node) => node.style });
  return { win, html, wrapper, dialog, list, cell };
}

test("scroll under a scroll-locked modal moves the dialog's list, not the document behind it", async () => {
  const { win, html, list } = page();
  const result = await observeScroll.call(win, 0, 600);
  assert.equal(result.target, "element");
  assert.equal(result.deltaY, 600);
  assert.equal(list.scrollTop, 600);
  assert.equal(html.scrollTop, 0);
  assert.equal(result.scroller, 'div in dialog "List members"');
  assert.deepEqual([result.scrollHeight, result.viewportHeight], [2800, 650]);
});

test("scroll on a zero-height dialog wrapper or on a list item moves the list that holds them", async () => {
  for (const pick of [(/** @type {any} */ p) => p.wrapper, (/** @type {any} */ p) => p.dialog, (/** @type {any} */ p) => p.cell]) {
    const parts = page(), result = await observeScroll.call(pick(parts), 0, 600);
    assert.deepEqual([result.target, result.deltaY, parts.list.scrollTop, parts.html.scrollTop], ["element", 600, 600, 0]);
  }
});

test("a list at its end reports an honest zero, and the locked document is not moved", async () => {
  const { win, html, list } = page();
  list.scrollTop = 2800 - 650;
  const result = await observeScroll.call(win, 0, 600);
  assert.deepEqual([result.target, result.deltaY, html.scrollTop, list.scrollTop], ["window", 0, 0, 2150]);
  assert.equal(result.scroller, undefined);
});

test("without a modal the document scrolls as before", async () => {
  const { win, html } = page({ locked: false, modal: false });
  const result = await observeScroll.call(win, 0, 600);
  assert.deepEqual([result.target, result.deltaY, html.scrollTop, result.scroller], ["window", 600, 600, undefined]);
});

test("a screen fraction moves an element that fraction of its own height", async () => {
  const { win, list } = page();
  const result = await observeScroll.call(win, 0, 1120, 0.8);
  assert.deepEqual([result.deltaY, list.scrollTop], [520, 520]);
});
