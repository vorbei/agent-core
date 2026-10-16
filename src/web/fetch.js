// One public web read without a browser: the URL policy (HTTP(S) only, no credentials, no private
// or local hosts, checked again after DNS and on every redirect), the bounded body read, and the
// read turned into untrusted evidence (readable text, or a preview image when the product can make one).
import dns from "node:dns";
import { createId, sha256 } from "../runtime/stamps.js";
import { extractReadableContent } from "./readable.js";

export const WEB_EVIDENCE_VERSION = "web-evidence-v1";
/** Raw bytes a read takes by default and at most (HTML, not output text). */
export const WEB_FETCH_DEFAULT_MAX_BYTES = 256 * 1024;
export const WEB_FETCH_MAX_BYTES = 256 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20_000;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "application/json"];

export class WebFetchError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [detail] */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "WebFetchError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Reads `input.url` (redirects revalidated) within `input.maxBytes` raw bytes and returns its
 * evidence. `imagePreview(bytes)` turns an image into a bounded `{ mimeType, data }` the model can
 * look at, or null; without it an image is an unsupported content type.
 */
export async function fetchWebEvidence(input, {
  fetchImpl = fetch,
  resolveHostname = resolvePublicHostname,
  imagePreview = null,
  now = () => new Date().toISOString(),
  timeoutMs = FETCH_TIMEOUT_MS
} = {}) {
  const requestedUrl = (await resolveSafeUrl(input?.url, resolveHostname)).toString();
  const maxBytes = boundedMaxBytes(input?.maxBytes);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = requestedUrl;
  let response;
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      response = await fetchImpl(currentUrl, {
        method: "GET",
        headers: { Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.1" },
        redirect: "manual",
        signal: controller.signal
      });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      await response.body?.cancel();
      if (redirects === MAX_REDIRECTS) throw new WebFetchError("WEB_FETCH_REDIRECT_LIMIT", "too many redirects");
      const location = response.headers.get("location");
      if (!location) throw new WebFetchError("WEB_FETCH_REDIRECT_INVALID", "redirect has no location");
      currentUrl = (await resolveSafeUrl(new URL(location, currentUrl).toString(), resolveHostname)).toString();
    }
    if (!response?.ok) {
      // The start of the server's reply says why (an API's "no data for that input" is an answer,
      // a block page is not), so the caller can tell a wrong request from an unavailable source.
      const status = response?.status || 0;
      const reply = response ? await errorReplyExcerpt(response, controller.signal) : null;
      const retryAfter = response?.headers.get("retry-after") || null;
      throw new WebFetchError("WEB_FETCH_HTTP_ERROR", `remote server returned ${status}${reply ? `; its reply begins (untrusted): ${JSON.stringify(reply)}` : ""}${retryAfter ? `; retry-after: ${retryAfter}` : ""}. Use another accessible source for the same claim, or an authorized browser read. Do not repeat the same blocked request.`,
        { status, ...(reply ? { reply } : {}), ...(retryAfter ? { retryAfter } : {}) });
    }
    const contentType = normalizeContentType(response.headers.get("content-type"));
    // A picture is looked at, not read: its evidence is a bounded preview image.
    if (/^image\/(png|jpeg|webp|gif)$/.test(contentType) && imagePreview) {
      const bytes = await readBoundedBytes(response.body, IMAGE_MAX_BYTES, controller.signal);
      const image = bytes.truncated ? null : await imagePreview(bytes.bytes);
      if (!image) throw new WebFetchError("WEB_FETCH_IMAGE_UNAVAILABLE", "the image could not be previewed; open it in the browser only if you must see it");
      const finalUrl = response.url ? validatePublicUrl(response.url).toString() : currentUrl;
      return { version: WEB_EVIDENCE_VERSION, evidenceId: createId("web"), requestedUrl, finalUrl, status: response.status, contentType,
        title: null, text: `[image ${contentType}, ${bytes.bytes.length} bytes; the preview is attached]`, publishedAt: null, contentKind: "image",
        fetchedAt: now(), truncated: false, contentHash: await sha256(base64(bytes.bytes)), trust: "untrusted",
        extractor: "image-preview-v1", image };
    }
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new WebFetchError("WEB_FETCH_CONTENT_TYPE", `unsupported content type: ${contentType || "unknown"}${contentType === "application/pdf" ? "; a PDF's text is read in the browser (read_text on the opened PDF)" : ""}`);
    }
    const body = await readBoundedText(response.body, maxBytes, controller.signal);
    const extracted = extractReadableContent(body.text, contentType);
    if (!extracted.text) throw new WebFetchError("WEB_FETCH_NO_CONTENT", body.truncated && maxBytes < WEB_FETCH_MAX_BYTES
      ? "No readable content before the raw HTML byte limit. Retry once with maxBytes=262144, then use another source if the needed passage is still missing."
      : "No readable content returned. Use another source or an authorized browser read; this page does not verify the claim.");
    const finalUrl = response.url ? validatePublicUrl(response.url).toString() : currentUrl;
    return {
      version: WEB_EVIDENCE_VERSION,
      evidenceId: createId("web"),
      requestedUrl,
      finalUrl,
      status: response.status,
      contentType,
      title: extracted.title,
      text: extracted.text,
      publishedAt: extracted.publishedAt || null,
      contentKind: extracted.contentKind,
      fetchedAt: now(),
      truncated: body.truncated,
      contentHash: await sha256(extracted.text),
      trust: "untrusted",
      extractor: "mozilla-readability-v1"
    };
  } catch (error) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    if (controller.signal.aborted) throw new WebFetchError("WEB_FETCH_TIMEOUT", "remote fetch timed out while receiving headers or body; use another accessible source");
    if (error instanceof WebFetchError) throw error;
    throw new WebFetchError("WEB_FETCH_FAILED", "remote fetch or content extraction failed; use another accessible source");
  } finally {
    clearTimeout(timeout);
  }
}

/** The URL when it is a public HTTP(S) address (no credentials, default ports, no private host); its fragment dropped. */
export function validatePublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw new WebFetchError("WEB_FETCH_URL_INVALID", "invalid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new WebFetchError("WEB_FETCH_URL_INVALID", "only HTTP(S) URLs are allowed");
  if (url.username || url.password) throw new WebFetchError("WEB_FETCH_URL_INVALID", "URL credentials are not allowed");
  if (url.port && !["80", "443"].includes(url.port)) throw new WebFetchError("WEB_FETCH_URL_BLOCKED", "URL port is not allowed");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isBlockedHostname(hostname)) throw new WebFetchError("WEB_FETCH_URL_BLOCKED", "URL host is not allowed");
  url.hash = "";
  return url;
}

/** `validatePublicUrl`, then every address the host name resolves to must be public too. */
export async function resolveSafeUrl(rawUrl, resolveHostname = resolvePublicHostname) {
  const url = validatePublicUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname)) return url;
  let addresses;
  try {
    addresses = await resolveHostname(hostname);
  } catch {
    throw new WebFetchError("WEB_FETCH_DNS_FAILED", "URL host could not be resolved");
  }
  if (!Array.isArray(addresses) || !addresses.length) throw new WebFetchError("WEB_FETCH_DNS_FAILED", "URL host could not be resolved");
  if (addresses.some((address) => isBlockedHostname(String(address)))) {
    throw new WebFetchError("WEB_FETCH_URL_BLOCKED", "URL host resolves to a blocked address");
  }
  return url;
}

/** The stream's bytes, or `{ truncated: true }` with no bytes once it passes `maxBytes`. */
export async function readBoundedBytes(stream, maxBytes, signal) {
  const chunks = [];
  let size = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); return { bytes: new Uint8Array(), truncated: true }; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated: false };
}

/** The stream's text up to `maxBytes`, cut there (`truncated`); the read stops when `signal` aborts. */
export async function readBoundedText(stream, maxBytes, signal) {
  if (!stream) return { text: "", truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  let truncated = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
        truncated = true;
        await reader.cancel();
        break;
      }
      size += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    text += decoder.decode();
    reader.releaseLock();
  }
  return { text, truncated };
}

const ERROR_REPLY_BYTES = 4096;
const ERROR_REPLY_CHARS = 300;

/** The first characters of an error response's text or JSON (an HTML page's title, or its text), or null. */
async function errorReplyExcerpt(response, signal) {
  const contentType = normalizeContentType(response.headers.get("content-type"));
  if (!response.body || !(contentType.startsWith("text/") || contentType === "application/json" || contentType.endsWith("+json"))) return null;
  try {
    const { text } = await readBoundedText(response.body, ERROR_REPLY_BYTES, signal);
    const html = /html/.test(contentType) || /^\s*</.test(text);
    const title = html ? text.match(/<title[^>]*>([^<]*)/i)?.[1] : null;
    const plain = (title || (html ? text.replace(/<(script|style)\b[\s\S]*?(<\/\1>|$)/gi, " ").replace(/<[^>]*>/g, " ") : text))
      .replace(/\s+/g, " ").trim();
    return plain ? plain.slice(0, ERROR_REPLY_CHARS) : null;
  } catch { return null; }
}

function boundedMaxBytes(value) {
  if (value === undefined) return WEB_FETCH_DEFAULT_MAX_BYTES;
  if (!Number.isInteger(value) || value < 1024 || value > WEB_FETCH_MAX_BYTES) {
    throw new WebFetchError("WEB_FETCH_INPUT_INVALID", `maxBytes must be between 1024 and ${WEB_FETCH_MAX_BYTES}`);
  }
  return value;
}

async function resolvePublicHostname(hostname) {
  const results = await Promise.allSettled([
    dns.promises.resolve4(hostname),
    dns.promises.resolve6(hostname)
  ]);
  const addresses = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  if (!addresses.length) throw new Error("DNS_EMPTY");
  return addresses;
}

function isBlockedHostname(hostname) {
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  if (["metadata.google.internal", "metadata.google", "instance-data.ec2.internal"].includes(hostname)) return true;
  if (hostname.includes(":")) return isBlockedIpv6(hostname);
  if (/^\d+(?:\.\d+){3}$/.test(hostname)) return isBlockedIpv4(hostname);
  return false;
}

function isBlockedIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0)
    || (a === 192 && b === 168) || (a === 198 && [18, 19].includes(b));
}

function isBlockedIpv6(hostname) {
  const value = hostname.toLowerCase();
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice(7);
    return mapped.includes(".") ? isBlockedIpv4(mapped) : true;
  }
  return value === "::" || value === "::1" || /^(fc|fd|fe[89ab])/.test(value);
}

function normalizeContentType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function base64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
