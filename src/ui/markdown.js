// The chat answer's Markdown lexer (marked, with bare links that stop at CJK prose punctuation) and
// the CJK-aware recovery of tight `**bold**` CommonMark leaves literal. From X Gardener
// src/ext/sidepanel/chat/markdown.js.
import { Marked, Tokenizer } from "marked";

// Only bare URLs use this tokenizer. Explicit Markdown/angle links can retain
// literal punctuation; prose delimiters must not become part of a bare href.
const URL_PROSE_BOUNDARY = /[，。；！？（）【】「」『』《》]/u;
export const chatMarkdown = new Marked({
  tokenizer: {
    url(source) {
      const token = Tokenizer.prototype.url.call(this, source);
      if (!token || !/^(?:https?:\/\/|www\.)/i.test(token.raw)) return token;
      const boundary = token.raw.search(URL_PROSE_BOUNDARY);
      return boundary < 0 ? token : Tokenizer.prototype.url.call(this, token.raw.slice(0, boundary));
    }
  }
});

const STRONG_DELIMITERS = /\*\*([^*\r\n]+?)\*\*/gu;
const HAN_TEXT = /\p{Script=Han}/u;

export function splitTightStrongFallback(value) {
  const source = String(value ?? "");
  const parts = [];
  let cursor = 0;

  for (const match of source.matchAll(STRONG_DELIMITERS)) {
    const start = match.index;
    const end = start + match[0].length;
    const inner = match[1];
    const before = source.slice(0, start).at(-1) || "";
    const after = source.slice(end)[0] || "";
    if (!shouldRecoverStrong(inner, before, after)) continue;

    appendText(parts, source.slice(cursor, start));
    const leadingSpace = inner.match(/^\s*/u)?.[0] || "";
    const trailingSpace = inner.match(/\s*$/u)?.[0] || "";
    const text = inner.slice(leadingSpace.length, inner.length - trailingSpace.length);
    appendText(parts, leadingSpace);
    parts.push({ type: "strong", text });
    appendText(parts, trailingSpace);
    cursor = end;
  }

  if (!parts.length) return source ? [{ type: "text", text: source }] : [];
  appendText(parts, source.slice(cursor));
  return parts;
}

function shouldRecoverStrong(inner, before, after) {
  const text = inner.trim();
  if (!text) return false;
  return HAN_TEXT.test(text)
    || /[：:]$/u.test(text)
    || Boolean(before && !/\s/u.test(before))
    || Boolean(after && !/\s/u.test(after));
}

function appendText(parts, text) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") previous.text += text;
  else parts.push({ type: "text", text });
}
