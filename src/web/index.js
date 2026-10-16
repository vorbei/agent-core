// The web layer's public surface: a public web read and a web search without a browser, for a
// product's Worker-side tools. Types are in index.d.ts.
export { fetchWebEvidence, readBoundedBytes, readBoundedText, resolveSafeUrl, validatePublicUrl, WEB_EVIDENCE_VERSION, WEB_FETCH_DEFAULT_MAX_BYTES,
  WEB_FETCH_MAX_BYTES, WebFetchError } from "./fetch.js";
export { extractReadableContent } from "./readable.js";
export { OPENROUTER_SEARCH_MODEL, openRouterSearchRequest, parseOpenRouterSearch, SEARCH_EVIDENCE_VERSION, searchWeb, webSearchInput } from "./search.js";
