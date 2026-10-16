// Safe Markdown for chat messages: the lexer's tokens become React elements (no HTML string is
// ever injected), links open only http(s) targets (a relative one against the product's
// `linkBase`), and an image loads only when the product's `imageSrc` admits its URL (otherwise its
// alt text is shown). From X Gardener chat/index.jsx.
import React from "react";
import { chatMarkdown, splitTightStrongFallback } from "./markdown.js";

/** `media`: the product's `{ imageSrc(href), linkBase }` (ChatSlots.markdown). */
export function Markdown({ text, media }) {
  return <>{renderMarkdownBlocks(chatMarkdown.lexer(String(text || "")), media)}</>;
}

function renderMarkdownBlocks(tokens = [], media) {
  const inline = (children) => renderMarkdownInline(children, media);
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "space") return null;
    if (token.type === "heading") {
      const tag = `h${Math.min(5, Math.max(3, Number(token.depth) || 3))}`;
      return React.createElement(tag, { key }, inline(token.tokens));
    }
    if (token.type === "paragraph") return <p key={key}>{inline(token.tokens)}</p>;
    if (token.type === "text") return <p key={key}>{inline(token.tokens || [token])}</p>;
    if (token.type === "list") {
      const tag = token.ordered ? "ol" : "ul";
      return React.createElement(tag, { key, ...(token.ordered && token.start !== 1 ? { start: token.start } : {}) },
        token.items.map((item, itemIndex) => <li key={itemIndex}>{renderMarkdownBlocks(item.tokens, media)}</li>));
    }
    if (token.type === "blockquote") return <blockquote key={key}>{renderMarkdownBlocks(token.tokens, media)}</blockquote>;
    if (token.type === "code") return <pre key={key}><code>{token.text}</code></pre>;
    if (token.type === "hr") return <hr key={key} />;
    if (token.type === "table") return <table key={key}><thead><tr>{token.header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell.tokens)}</th>)}</tr></thead><tbody>{token.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell.tokens)}</td>)}</tr>)}</tbody></table>;
    if (token.type === "html") return <p key={key}>{token.text}</p>;
    return token.tokens?.length ? <React.Fragment key={key}>{inline(token.tokens)}</React.Fragment> : null;
  });
}

function renderMarkdownInline(tokens = [], media) {
  const inline = (children) => renderMarkdownInline(children, media);
  return tokens.map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "text") return <React.Fragment key={key}>{renderMarkdownText(token.text, key)}</React.Fragment>;
    if (token.type === "escape") return <React.Fragment key={key}>{token.text}</React.Fragment>;
    if (token.type === "strong") return <strong key={key}>{inline(token.tokens)}</strong>;
    if (token.type === "em") return <em key={key}>{inline(token.tokens)}</em>;
    if (token.type === "del") return <del key={key}>{inline(token.tokens)}</del>;
    if (token.type === "codespan") return <code key={key}>{token.text}</code>;
    if (token.type === "br") return <br key={key} />;
    if (token.type === "link") {
      const href = safeMarkdownHref(token.href, media?.linkBase);
      return href ? <a key={key} href={href} target="_blank" rel="noreferrer">{inline(token.tokens)}</a> : <React.Fragment key={key}>{inline(token.tokens)}</React.Fragment>;
    }
    if (token.type === "image") {
      // Only media the product admits is loaded; any other image stays its alt text, so an answer
      // cannot make the panel fetch an arbitrary URL.
      const src = media?.imageSrc?.(token.href) || null;
      return src ? <a key={key} href={src} target="_blank" rel="noreferrer"><img className="chat-image" src={src} alt={token.text || "Generated image"} loading="lazy" /></a>
        : <React.Fragment key={key}>{token.text || "Image"}</React.Fragment>;
    }
    return token.tokens?.length ? <React.Fragment key={key}>{inline(token.tokens)}</React.Fragment> : <React.Fragment key={key}>{token.text || ""}</React.Fragment>;
  });
}

function renderMarkdownText(text, key) {
  return splitTightStrongFallback(text).map((part, index) => part.type === "strong"
    ? <strong key={`${key}-strong-${index}`}>{part.text}</strong>
    : <React.Fragment key={`${key}-text-${index}`}>{part.text}</React.Fragment>);
}

/** An http(s) link target, or null; a site-relative path stays relative, another resolves against `base`. */
export function safeMarkdownHref(value, base = "https://invalid.example") {
  try {
    const url = new URL(String(value || ""), base);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return String(value).startsWith("/") ? url.pathname + url.search + url.hash : url.href;
  } catch {
    return null;
  }
}
