// The readable text of a fetched document: an article through Mozilla Readability over an inert
// linkedom DOM (no scripts, cookies, subresource loading or rendering), else the page's semantic
// text; JSON pretty-printed and plain text as it is.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/** `{ title, text, publishedAt, contentKind: "article" | "page_text" }` of a document body of `contentType`. */
export function extractReadableContent(input, contentType) {
  if (contentType === "application/json") {
    try { return { title: null, text: JSON.stringify(JSON.parse(input), null, 2), contentKind: "page_text" }; }
    catch { return { title: null, text: input.trim(), contentKind: "page_text" }; }
  }
  if (!["text/html", "application/xhtml+xml"].includes(contentType)) {
    return { title: null, text: input.trim(), contentKind: "page_text" };
  }
  const { document } = parseHTML(/<html\b/i.test(input) ? input : `<html><body>${input}</body></html>`);
  const title = document.querySelector("title")?.textContent.trim().slice(0, 500) || null;
  const published = document.querySelector('meta[property="article:published_time"],meta[name="datePublished"]')?.getAttribute("content");
  // Remove navigation even from truncated documents, where its closing tag may
  // never have arrived. Do not expose tag fragments or nav text as article text.
  for (const node of document.querySelectorAll('nav,footer,aside,form,[role="navigation"],[hidden],[aria-hidden="true"],style,noscript,svg,template')) node.remove();
  let article;
  try {
    article = new Readability(document.cloneNode(true), {
      maxElemsToParse: 20_000, serializer: readableText
    }).parse();
  } catch { /* Non-article pages still have a useful semantic-text fallback. */ }
  for (const node of document.querySelectorAll("head,script,body > header")) node.remove();
  const text = article?.content?.trim() || readableText(document.querySelector("article,main,[role=main]") || document.body);
  // Publication metadata belongs to the source, not the observation clock or URL.
  const rawDate = article?.publishedTime || published;
  const publishedAt = typeof rawDate === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(rawDate)
    && Number.isFinite(Date.parse(rawDate)) ? rawDate : null;
  return { title: article?.title?.slice(0, 500) || title, text, publishedAt,
    contentKind: article?.content?.trim() ? "article" : "page_text" };
}

function readableText(root) {
  if (!root) return "";
  for (const node of root.querySelectorAll("head,title,meta,script,style,noscript,svg,template")) node.remove();
  for (const node of root.querySelectorAll("br,p,div,article,main,section,header,li,h1,h2,h3,h4,h5,h6,tr")) {
    node.appendChild(root.ownerDocument.createTextNode("\n"));
  }
  return root.textContent.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}
