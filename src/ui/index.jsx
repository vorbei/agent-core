// The shared chat UI's public surface: `mountChat` renders the chat of the current account into an
// element over the product's ChatClient and ChatSlots and returns the handle the product's shell
// drives; the panel shell's header helpers, the components and helpers are exported for products
// and tests. Types are in index.d.ts.
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatConfig } from "./config.js";
import { ChatHost } from "./chat-host.jsx";
import { defaultWording } from "./wording.js";

export { ChatHost, THREAD_LIST_LIMIT, TURN_PAGE_SIZE } from "./chat-host.jsx";
export { ChatConfig } from "./config.js";
export { ComposerSettings } from "./composer-settings.jsx";
export { Markdown, safeMarkdownHref } from "./markdown.jsx";
export { chatMarkdown, splitTightStrongFallback } from "./markdown.js";
export { Message, Turn, TurnGroup, formatMessageTime } from "./turn.jsx";
export { ThreadGroup, ThreadMenu, threadTitle } from "./thread-menu.jsx";
export { bindPanelHeader, markPanelView, panelHeaderMarkup } from "./panel-shell.js";
export { focusPageTitle, pageHeadMarkup } from "./page.js";
export { groupTurns } from "./turn-groups.js";
export { IMAGE_INPUT_TYPES, IMAGE_LIMITS, prepareChatImage } from "./image-attachments.js";
export { defaultWording } from "./wording.js";

/**
 * @param {Element} element
 * @param {{ client: (account: { accountId: string }) => any, slots?: Record<string, any>,
 *   menu?: { trigger: Element, root: Element } | null, pageSize?: number }} options
 */
export function mountChat(element, { client, slots = {}, menu = null, pageSize }) {
  const root = createRoot(element);
  const config = { wording: { ...defaultWording(slots.wording?.assistant), ...slots.wording }, slots };
  const inputRef = { current: null };
  let account = null;
  let composerRequest = { text: "", revision: 0 };
  let threadRequest = { threadId: null, revision: 0 };
  const render = () => root.render(<ChatConfig.Provider value={config}>
    <ChatHost account={account} client={client} menu={menu} inputRef={inputRef} pageSize={pageSize}
      composerRequest={composerRequest} threadRequest={threadRequest} />
  </ChatConfig.Provider>);
  render();
  return {
    /** The chat follows this account (null hides it); the same account again changes nothing. */
    setAccount(next) {
      const same = account && next && Object.keys({ ...account, ...next }).every((key) => account[key] === next[key]);
      if (same || account === next) return;
      account = next;
      render();
    },
    /** Renders again, for slots whose product state changed. */
    render,
    focus() { inputRef.current?.focus(); },
    /** Puts text in the message box and focuses it. */
    compose(text) {
      composerRequest = { text: String(text || ""), revision: composerRequest.revision + 1 };
      render();
    },
    openThread(threadId) {
      threadRequest = { threadId, revision: threadRequest.revision + 1 };
      render();
    },
    unmount() { root.unmount(); }
  };
}
