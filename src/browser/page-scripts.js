// Functions that run inside the page (sent as source with Runtime.callFunctionOn or evaluate).
// They never modify the page. Each states what `this` is.

/**
 * Whether the element at (x, y) in `el`'s document is `el` or reaches it through its composed
 * ancestry. Open shadow roots are descended; a closed shadow root retargets the hit to its host,
 * which is as deep as a page script can see, so a host of `el` is accepted. A label forwards its
 * click to its control. Any other element covers `el`. (From X Gardener src/browser/frame.js.)
 * @param {any} el @param {number} x @param {number} y @returns {boolean}
 */
export function hitsComposedTarget(el, x, y) {
  const within = (/** @type {any} */ node) => { for (; node; node = node.parentNode || node.host) if (node === el) return true; return false; };
  const hosts = [];
  for (let root = el.getRootNode(); root && root.host; root = root.host.getRootNode()) hosts.push(root.host);
  let hit = el.ownerDocument.elementFromPoint(x, y);
  while (hit) {
    if (within(hit) || hit.closest?.("label")?.control === el) return true;
    if (!hit.shadowRoot) return hosts.includes(hit);
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) return false;
    hit = inner;
  }
  return false;
}

/**
 * `this` is the click target. Arguments: (x, y, crossOrigin, content, local). (x, y) is the
 * point input will be dispatched at: root-viewport coordinates, or the frame's own viewport when
 * `local` (a cross-process iframe's session). Returns true when the point hits the target, else
 * `{ covering, popup, retry? }` naming what is on top. `crossOrigin`: the embedding chain cannot be read,
 * so the target's own center is tested in its document; it is also assumed when the chain ends
 * at a window other than the top one and the point is not `local`. `content`: test the content
 * box center. From X Gardener src/browser/controls.js (clickAxBoundControl's hit test).
 */
export const HIT_TEST = `function(x, y, crossOrigin, content, local) {
  if (!this.isConnected) return false;
  const hits = ${hitsComposedTarget};
  // Each embedding frame must be hit in its own document (possibly as a shadow host's
  // descendant); the target is then tested in its own document with frame-local coordinates.
  const frames = [];
  let top = this.ownerDocument.defaultView;
  if (!crossOrigin) for (; top && top.frameElement; top = top.parent) frames.push(top.frameElement);
  if (!crossOrigin && !local && top && top.top !== undefined && top !== top.top) crossOrigin = true;
  if (crossOrigin) {
    frames.length = 0;
    const rect = this.getBoundingClientRect(); x = rect.x + rect.width / 2; y = rect.y + rect.height / 2;
    if (content) {
      const s = getComputedStyle(this), n = key => parseFloat(s[key]) || 0;
      x = rect.x + (n('borderLeftWidth') + n('paddingLeft') + (this.clientWidth - n('paddingLeft') - n('paddingRight')) / 2) * rect.width / this.offsetWidth;
      y = rect.y + (n('borderTopWidth') + n('paddingTop') + (this.clientHeight - n('paddingTop') - n('paddingBottom')) / 2) * rect.height / this.offsetHeight;
    }
  }
  for (const frame of frames.reverse()) {
    if (!hits(frame, x, y)) return false;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height || !frame.offsetWidth || !frame.offsetHeight) return false;
    x = (x - rect.x) * frame.offsetWidth / rect.width - frame.clientLeft;
    y = (y - rect.y) * frame.offsetHeight / rect.height - frame.clientTop;
  }
  if (hits(this, x, y)) return true;
  // Name what is on top, so the caller can tell a menu or mask from a layout overlap.
  const above = this.ownerDocument.elementFromPoint(x, y);
  if (!above) return { covering: null };
  // innerText follows layout, so a menu's items stay separate words ("Mute Block", not "MuteBlock").
  const label = el => String(el.getAttribute?.("aria-label") || el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60);
  // A menu's backdrop has no role of its own: name the open popup, not the empty layer on top of the target.
  const popups = '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[aria-modal=true],dialog[open]';
  const shown = el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const layer = above.closest?.(popups) || [...(this.ownerDocument.querySelectorAll?.(popups) || [])].filter(shown).pop() || null;
  // What scrolling the target does to the page, which settles: \`retry\`. The point hits an
  // ancestor of the target (X's timelines set pointer-events:none on their cells while they
  // scroll), or a sticky or fixed bar in the target's own layer (a dialog's sticky header over a
  // row at the top edge of its list). Not a menu, a dialog or a page-sized mask on top of it.
  let reaches = false;
  for (let node = this; node; node = node.parentNode || node.host) if (node === above) { reaches = true; break; }
  const view = this.ownerDocument.defaultView, position = el => view?.getComputedStyle?.(el)?.position;
  let bar = null;
  for (let el = above; el && el.nodeType === 1 && !bar; el = el.parentElement) if (/^(sticky|fixed)$/.test(position(el) || "")) bar = el;
  const barRect = bar?.getBoundingClientRect?.();
  const retry = reaches || Boolean(bar && !bar.contains(this) && !bar.matches?.(popups) && barRect && barRect.height < (view?.innerHeight || 0) / 2
    && (bar.closest?.(popups) || null) === (this.closest?.(popups) || null));
  return { covering: { tag: String(above.tagName || "element").toLowerCase(), role: above.getAttribute?.("role") || null, name: label(above) },
    ...(layer && layer !== above ? { popup: { role: layer.getAttribute("role") || "dialog", name: label(layer) } } : {}), ...(retry ? { retry: true } : {}) };
}`;

/**
 * `this` is `window` or an element. Scrolls by (dx, dy) natively and observes once, without
 * replaying input, until the position is stable for 150 ms (at most 750 ms). Timers also work when
 * animation frames are throttled. From X Gardener src/browser/agent/scroll.js, after agent-browser
 * v0.37.0 interaction::scroll (DOM scrollBy, not a mouse wheel).
 *
 * What moves is what a person could move that way. An element that cannot hands the scroll to its
 * largest visible scroll container inside it (a dialog wrapper), else to its nearest scrollable
 * ancestor (a list item), else to the page. On the page, the topmost open modal's largest scroll
 * container moves (X's List members); without one the document does, and when the document cannot
 * (scroll-locked by overflow hidden, or at its edge) an open non-modal dialog's container does.
 * When nothing can move, an element is scrolled anyway and the zero delta is reported; a
 * scroll-locked document is not moved behind its dialog. `scroller` names an element that moved in
 * place of `this`. `screen` (a fraction, optional): an element that moves goes that fraction of its
 * own height or width, in the direction of (dx, dy), instead of (dx, dy).
 * @this {any} @param {number} dx @param {number} dy @param {number} [screen]
 */
export async function observeScroll(dx, dy, screen) {
  const doc = window.document, root = doc.scrollingElement || doc.documentElement;
  const modals = '[aria-modal=true],dialog:modal', dialogs = '[aria-modal=true],dialog[open],[role=dialog],[role=alertdialog]';
  const isDocument = (/** @type {any} */ el) => el === window || el === root || el === doc.documentElement || el === doc.body;
  const container = (/** @type {string} */ overflow) => overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  const room = (/** @type {number} */ offset, /** @type {number} */ size, /** @type {number} */ view, /** @type {number} */ d) =>
    d > 0 ? offset + view < size - 1 : d < 0 ? offset > 0 : false;
  // A person can move this element by (dx, dy): a visible scroll container with room that way.
  const movable = (/** @type {any} */ el) => {
    if (isDocument(el)) return false;
    const box = el.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return false;
    const style = getComputedStyle(el);
    return container(style.overflowY) && room(el.scrollTop, el.scrollHeight, el.clientHeight, dy)
      || container(style.overflowX) && room(Math.abs(el.scrollLeft), el.scrollWidth, el.clientWidth, dx);
  };
  // The viewport takes the root's overflow, or the body's when the root's is visible.
  const documentMovable = () => {
    const rootOverflow = getComputedStyle(doc.documentElement).overflowY;
    const overflow = rootOverflow === 'visible' && doc.body ? getComputedStyle(doc.body).overflowY : rootOverflow;
    if (overflow === 'hidden' || overflow === 'clip') return false;
    return room(window.scrollY, root.scrollHeight, window.innerHeight, dy) || room(Math.abs(window.scrollX), root.scrollWidth, window.innerWidth, dx);
  };
  const largestWithin = (/** @type {any} */ el) => {
    let best = null, area = 0;
    for (const node of el.querySelectorAll('*')) {
      const size = node.clientWidth * node.clientHeight;
      if (size > area && movable(node)) { best = node; area = size; }
    }
    return best;
  };
  // The last match in document order is taken as the topmost (X's #layers, a portal at the end).
  const topmost = (/** @type {string} */ selector) => {
    const open = [...doc.querySelectorAll(selector)];
    for (let i = open.length - 1; i >= 0; i--) {
      const found = movable(open[i]) ? open[i] : largestWithin(open[i]);
      if (found) return found;
    }
    return null;
  };
  const page = () => topmost(modals) || (documentMovable() ? window : topmost(dialogs));
  /** @param {any} el @returns {any} */
  const resolve = el => {
    if (isDocument(el)) return page();
    if (movable(el)) return el;
    const inside = largestWithin(el);
    if (inside) return inside;
    for (let node = el.parentElement; node && !isDocument(node); node = node.parentElement) if (movable(node)) return node;
    return page();
  };
  const resolved = resolve(this);
  // A scroll-locked document is not moved behind its dialog, though a script could move it.
  const target = resolved || (isDocument(this) ? window : this);
  const isWindow = target === window;
  const position = () => isWindow ? [window.scrollX, window.scrollY] : [target.scrollLeft, target.scrollTop];
  const before = position();
  if (screen && screen > 0 && !isWindow) {
    dx = Math.sign(dx) * Math.round(target.clientWidth * screen);
    dy = Math.sign(dy) * Math.round(target.clientHeight * screen);
  }
  if (resolved || !isWindow) target.scrollBy(dx, dy);
  const started = performance.now();
  let last = position(), stableSince = started;
  while (performance.now() - started < 750) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const now = performance.now(), current = position();
    if (current[0] !== last[0] || current[1] !== last[1]) stableSince = now;
    last = current;
    if (now - stableSince >= 150) break;
  }
  const name = (/** @type {any} */ el) => String(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/)
    .map((/** @type {string} */ id) => id && doc.getElementById(id)?.textContent || '').join(' ')).trim().replace(/\s+/g, ' ').slice(0, 60);
  const describe = (/** @type {any} */ el) => {
    const dialog = el.parentElement?.closest(dialogs), own = name(el), outer = dialog ? name(dialog) : '';
    return (el.getAttribute('role') || el.localName) + (own ? ` "${own}"` : '')
      + (dialog ? ` in ${dialog.getAttribute('role') || 'dialog'}${outer ? ` "${outer}"` : ''}` : '');
  };
  return { target: isWindow ? 'window' : 'element', scrollX: last[0], scrollY: last[1],
    deltaX: last[0] - before[0], deltaY: last[1] - before[1], settled: performance.now() - stableSince >= 150,
    scrollHeight: isWindow ? root.scrollHeight : target.scrollHeight, viewportHeight: isWindow ? window.innerHeight : target.clientHeight,
    ...(resolved && !isWindow && resolved !== this ? { scroller: describe(resolved) } : {}) };
}

/**
 * `this` is a native <select>; the argument is a list of option values or visible texts.
 * agent-browser v0.37.0 SELECT_OPTIONS (cli/src/native/interaction.rs, Apache-2.0; see
 * LICENSE-agent-browser). Changed: fires `input` before `change` as a user's choice does, and
 * reports the chosen options' texts.
 */
export const SELECT_OPTIONS = `function(vals) {
  const options = Array.from(this.options);
  let matched = 0;
  for (const opt of options) {
    opt.selected = vals.includes(opt.value) || vals.includes(opt.textContent.trim());
    if (opt.selected) matched += 1;
  }
  if (matched === 0) {
    const available = options.map(o => o.value + ' ("' + o.textContent.trim() + '")').join(', ');
    return { error: 'No option matched ' + JSON.stringify(vals) + '. Available options: ' + available };
  }
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { matched, chosen: options.filter(o => o.selected).map(o => o.textContent.trim()) };
}`;

/**
 * `this` is a document, in the page's own world (so an `onclick` a script assigned is seen).
 * Returns the elements that act like controls without an ARIA control role: cursor:pointer not
 * inherited from the parent, an onclick handler, a tabindex, or contenteditable; at most `max`.
 * The cursor-discovery test of agent-browser v0.37.0 (cli/src/native/snapshot.rs, Apache-2.0;
 * see LICENSE-agent-browser). Changed: returns the elements instead of marking them with a DOM
 * attribute (the page is not modified), and is bounded.
 */
export const DISCOVER_CLICKABLES = `function(max) {
  const doc = this, results = [];
  if (!doc.body) return results;
  const view = doc.defaultView;
  const interactiveRoles = { button: 1, link: 1, textbox: 1, checkbox: 1, radio: 1, combobox: 1, listbox: 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, option: 1, searchbox: 1, slider: 1, spinbutton: 1, switch: 1, tab: 1, treeitem: 1 };
  const interactiveTags = { a: 1, button: 1, input: 1, select: 1, textarea: 1, details: 1, summary: 1 };
  const all = doc.body.querySelectorAll('*');
  for (let i = 0; i < all.length && results.length < max; i++) {
    const el = all[i];
    if (el.closest && el.closest('[hidden], [aria-hidden="true"]')) continue;
    if (interactiveTags[el.tagName.toLowerCase()]) continue;
    const role = el.getAttribute('role');
    if (role && interactiveRoles[role.toLowerCase()]) continue;
    const style = view.getComputedStyle(el);
    const hasCursorPointer = style.cursor === 'pointer';
    const hasOnClick = el.hasAttribute('onclick') || el.onclick !== null;
    const tabIndex = el.getAttribute('tabindex');
    const hasTabIndex = tabIndex !== null && tabIndex !== '-1';
    const ce = el.getAttribute('contenteditable');
    const isEditable = ce === '' || ce === 'true';
    if (!hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) continue;
    // Skip elements that only inherit cursor:pointer from an ancestor.
    if (hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) {
      const parent = el.parentElement;
      if (parent && view.getComputedStyle(parent).cursor === 'pointer') continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    results.push(el);
  }
  return results;
}`;

/**
 * `this` is the array DISCOVER_CLICKABLES returned. Describes each element as agent-browser's
 * cursor script does (`text`: textContent, trimmed, 100 characters; the hidden radio/checkbox a
 * card wraps), plus `label`: its rendered text with whitespace collapsed.
 */
export const DESCRIBE_CLICKABLES = `function() {
  return this.map(el => {
    const view = el.ownerDocument.defaultView;
    const tabIndex = el.getAttribute('tabindex');
    const ce = el.getAttribute('contenteditable');
    let hiddenInputType = null, hiddenInputChecked = null;
    // A <label> wrapping a display:none radio/checkbox styled as a card. Only display/visibility/hidden
    // count: opacity:0 or sr-only inputs stay in the accessibility tree as radios already.
    const hiddenInput = el.querySelector('input[type="radio"], input[type="checkbox"]');
    if (hiddenInput) {
      const s = view.getComputedStyle(hiddenInput);
      if (s.display === 'none' || s.visibility === 'hidden' || hiddenInput.hidden) {
        hiddenInputType = hiddenInput.type;
        hiddenInputChecked = hiddenInput.indeterminate ? 'mixed' : String(hiddenInput.checked);
      }
    }
    return {
      text: (el.textContent || '').trim().slice(0, 100),
      label: String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
      tagName: el.tagName.toLowerCase(),
      hasOnClick: el.hasAttribute('onclick') || el.onclick !== null,
      hasCursorPointer: view.getComputedStyle(el).cursor === 'pointer',
      hasTabIndex: tabIndex !== null && tabIndex !== '-1',
      isEditable: ce === '' || ce === 'true',
      hiddenInputType, hiddenInputChecked,
    };
  });
}`;
