// A Worker script the extension does not ship but pins: fetched from the product's server, used
// only when its SHA-256 equals the hash the extension was built with, and kept in the extension's
// Cache API under that hash, so a later run needs no network. Anything else is refused.

// The cache name, and the key prefix the hash is stored under (a key only, never fetched).
const CACHE_NAME = "agent-core-code-source";
const CACHE_KEY = "https://code-source.invalid/";

/** @param {string} code @param {string} message */
const sourceError = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

/**
 * The SHA-256 of bytes, as lowercase hex.
 * @param {ArrayBuffer | Uint8Array} bytes
 */
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The pinned script's text: from the cache when its bytes still match `sha256`, else from `url`.
 * Throws `SANDBOX_SOURCE_UNAVAILABLE` (not reachable, not served) or `SANDBOX_SOURCE_MISMATCH`
 * (served bytes are not the pinned build); a mismatched download is never cached.
 * @param {{ sha256: string, url: string, fetch: typeof globalThis.fetch, caches?: CacheStorage | null }} options
 * @returns {Promise<string>}
 */
export async function loadPinnedSource({ sha256, url, fetch, caches }) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw sourceError("SANDBOX_SOURCE_MISMATCH", "the pinned hash is not a SHA-256");
  const key = `${CACHE_KEY}${sha256}.js`;
  const cache = caches ? await caches.open(CACHE_NAME).catch(() => null) : null;
  const cached = await cache?.match(key).catch(() => undefined);
  if (cached) {
    const bytes = await cached.arrayBuffer();
    if (await sha256Hex(bytes) === sha256) return new TextDecoder().decode(bytes);
    await cache?.delete(key).catch(() => false);
  }
  /** @type {Response} */
  let response;
  try { response = await fetch(url, { credentials: "omit", cache: "no-cache" }); }
  catch (error) { throw sourceError("SANDBOX_SOURCE_UNAVAILABLE", `could not fetch ${url}: ${String(/** @type {Error} */ (error)?.message ?? error)}`); }
  if (!response.ok) throw sourceError("SANDBOX_SOURCE_UNAVAILABLE", `${url} answered HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const actual = await sha256Hex(bytes);
  if (actual !== sha256) throw sourceError("SANDBOX_SOURCE_MISMATCH", `${url} has SHA-256 ${actual}, this extension pins ${sha256}`);
  await cache?.put(key, new Response(bytes, { headers: { "Content-Type": "text/javascript" } })).catch(() => {});
  return new TextDecoder().decode(bytes);
}
