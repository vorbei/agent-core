// What the runtime stamps its rows with: ids, SHA-256 hashes, canonical JSON and the host's clock.

/** @param {string} prefix */
export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Lowercase hex SHA-256 of a string (UTF-8) or bytes. @param {string | Uint8Array} value */
export async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes as lowercase hex: an account token's secret part, a one-time ticket. */
export function createSecret() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The value with every object's keys sorted, so equal arguments hash equally in any key order. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** The host's clock in milliseconds (tests pass a fake one); the wall clock when it has none. */
export const nowMs = host => (host.now ? host.now() : Date.now());
export const nowIso = host => new Date(nowMs(host)).toISOString();
