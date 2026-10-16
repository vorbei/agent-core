// The server-side PDF read both products run when the agent reads a PDF: the PDF is fetched by its
// public http(s) URL without cookies or credentials (every redirect validated again, a size and a
// time cap), converted to Markdown by Workers AI `toMarkdown`, and returned page by page with a
// `--- page N ---` line before each, from the page the URL names with `#page=N`. A product's cache
// (its storage) skips the fetch and conversion of a PDF read before. From pi-do src/worker/pdf.ts
// and X Gardener's browser read of a PDF (its pdfPages, from a since-removed Gardener module).

/** The default caps: a larger PDF is refused, the whole fetch is aborted after the timeout. */
export const PDF_READ_LIMITS = Object.freeze({ maxBytes: 30 * 1024 * 1024, fetchTimeoutMs: 30_000, maxRedirects: 5 });

/** A PDF that could not be read: `stage` is where it failed, the message says why in plain words. */
export class PdfReadError extends Error {
  /** @param {string} code @param {"fetch" | "convert"} stage @param {string} message */
  constructor(code, stage, message) { super(message); this.name = "PdfReadError"; this.code = code; this.stage = stage; }
}

const fetchError = (code, message) => new PdfReadError(code, "fetch", message);
const convertError = (code, message) => new PdfReadError(code, "convert", message);

/** The 1-based page a PDF URL asks for with `#page=N`, or 1. */
export function pdfStartPage(url) {
  let hash = "";
  try { hash = new URL(url).hash; } catch { return 1; }
  const match = /[#&]page=(\d{1,6})\b/.exec(hash);
  return match ? Math.max(1, Number(match[1])) : 1;
}

// Workers AI writes a PDF as "# <file name>", a "## Metadata" list of Key=value lines, then
// "## Contents" with a "### Page N" heading before each page (observed output; Cloudflare does not
// document the layout). Each heading becomes a "--- page N ---" line. Without page headings the
// contents are one block and `pages` is null. Pages after the one that passes `maxChars` are left out.
/** @returns {{ title: string | null, pages: number | null, from: number, firstPage: number | null, text: string }} */
export function pdfPages(markdown, from = 1, maxChars = Infinity) {
  const contents = /^##\s+Contents\s*$/m.exec(markdown);
  const metadata = contents ? markdown.slice(0, contents.index) : "";
  const title = /^-\s*Title=(.+)$/m.exec(metadata)?.[1]?.trim() || null;
  const parts = (contents ? markdown.slice(contents.index + contents[0].length) : markdown).split(/^###\s+Page\s+(\d+)\s*$/m);
  if (parts.length < 3) return { title, pages: null, from, firstPage: null, text: parts[0].trim() };
  const pages = [];
  for (let index = 1; index < parts.length; index += 2) pages.push({ number: Number(parts[index]), text: parts[index + 1].trim() });
  let text = "", firstPage = null;
  for (const page of pages) {
    if (page.number < from) continue;
    if (text.length > maxChars) break;
    firstPage ??= page.number;
    text += `${text ? "\n\n" : ""}--- page ${page.number} ---\n${page.text}`;
  }
  return { title, pages: pages.length, from, firstPage, text };
}

/**
 * Reads the PDF at `url` (see the file header). `toMarkdown` is the Workers AI binding's (null: the
 * Worker has none); `validateUrl` returns the public URL to fetch (without its fragment) or throws
 * a PdfReadError, by default `publicPdfUrl`; `cache` maps the fetched URL to an earlier conversion.
 * Throws PdfReadError: PDF_URL_INVALID, PDF_FETCH_FAILED, PDF_TOO_LARGE, PDF_INVALID (stage fetch),
 * PDF_CONVERTER_MISSING, PDF_CONVERSION_FAILED, PDF_NO_TEXT (stage convert).
 */
export async function readPdf(url, { fetch, toMarkdown, cache, validateUrl = publicPdfUrl, limits = PDF_READ_LIMITS, maxChars = Infinity }) {
  const target = validateUrl(url);
  const from = pdfStartPage(url);
  const cached = await cache?.get(target).catch(() => null);
  if (cached) return pdfPages(cached, from, maxChars);
  const bytes = await fetchPdf(target, { fetch, validateUrl, limits });
  if (!toMarkdown) throw convertError("PDF_CONVERTER_MISSING", "this Worker has no Workers AI binding");
  let result;
  try {
    [result] = [await toMarkdown([{ name: "document.pdf", blob: new Blob([bytes], { type: "application/pdf" }) }])].flat();
  } catch (error) {
    throw convertError("PDF_CONVERSION_FAILED", `the conversion failed: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  if (result?.format === "error") throw convertError("PDF_CONVERSION_FAILED", `the conversion failed: ${String(result.error ?? "").slice(0, 200)}`);
  const markdown = result?.format === "markdown" ? String(result.data ?? "").trim() : "";
  if (!markdown) throw convertError("PDF_NO_TEXT", "the conversion returned no text (a scanned, image-only PDF has none)");
  await cache?.put(target, markdown).catch(() => {});
  return pdfPages(markdown, from, maxChars);
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

// The PDF's bytes, fetched with no cookies or credentials; every redirect is validated again.
async function fetchPdf(url, { fetch, validateUrl, limits }) {
  const signal = AbortSignal.timeout(limits.fetchTimeoutMs);
  const unreachable = () => fetchError("PDF_FETCH_FAILED", signal.aborted
    ? `no complete response within ${limits.fetchTimeoutMs / 1000} s` : "the PDF's server could not be reached");
  let target = url;
  for (let redirects = 0; ; redirects++) {
    let response;
    try { response = await fetch(target, { redirect: "manual", signal, headers: { Accept: "application/pdf,*/*" } }); }
    catch { throw unreachable(); }
    if (REDIRECT.has(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects >= limits.maxRedirects) throw fetchError("PDF_FETCH_FAILED", "too many redirects");
      target = validateUrl(new URL(location, target).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw fetchError("PDF_FETCH_FAILED", response.status === 401 || response.status === 403
        ? `HTTP ${response.status}: the PDF needs a login or is restricted, and it is fetched without your cookies`
        : `HTTP ${response.status}`);
    }
    const tooLarge = () => fetchError("PDF_TOO_LARGE", `the PDF is larger than ${limits.maxBytes / 1024 / 1024} MiB`);
    if (Number(response.headers.get("content-length")) > limits.maxBytes) { await response.body?.cancel(); throw tooLarge(); }
    let bytes;
    try { bytes = await readBounded(response, limits.maxBytes); }
    catch { throw unreachable(); }
    if (!bytes) throw tooLarge();
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
      throw fetchError("PDF_INVALID", "the URL did not return a PDF (usually a login or consent page served instead, since it is fetched without your cookies)");
    }
    return bytes;
  }
}

async function readBounded(response, maxBytes) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * The default `validateUrl`: a public http(s) URL without credentials, returned without its
 * fragment. `allowLoopback` admits loopback hosts (a local smoke's PDFs only).
 */
export function publicPdfUrl(raw, { allowLoopback = false } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw fetchError("PDF_URL_INVALID", "the PDF URL is invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw fetchError("PDF_URL_INVALID", "only http(s) PDF URLs are read");
  if (url.username || url.password) throw fetchError("PDF_URL_INVALID", "PDF URLs with credentials are not read");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!(allowLoopback && isLoopback(host)) && isPrivateHost(host)) throw fetchError("PDF_URL_INVALID", "only PDFs on public hosts are read");
  url.hash = "";
  return url.href;
}

const isLoopback = host => host === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(host) || host === "::1";

function isPrivateHost(host) {
  if (!host || host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return true;
  if (host.includes(":")) {
    if (host.startsWith("::ffff:")) return host.includes(".") ? isPrivateIpv4(host.slice(7)) : true;
    return host === "::" || host === "::1" || /^(fc|fd|fe[89ab])/.test(host);
  }
  return /^\d+(\.\d+){3}$/.test(host) && isPrivateIpv4(host);
}

function isPrivateIpv4(host) {
  const [a, b] = host.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
