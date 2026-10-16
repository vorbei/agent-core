import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReadableContent, fetchWebEvidence, resolveSafeUrl, searchWeb, validatePublicUrl, WebFetchError, webSearchInput } from "../../src/web/index.js";

const PUBLIC = async () => ["93.184.216.34"];

test("the URL policy refuses private, credentialed and non-HTTP targets, including by DNS and on a redirect", async () => {
  for (const url of ["file:///etc/passwd", "http://localhost/admin", "http://127.0.0.1/", "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data",
    "http://[::1]/", "https://user:pass@example.com/", "https://example.com:8443/"]) assert.throws(() => validatePublicUrl(url), WebFetchError, url);
  assert.equal(validatePublicUrl("https://example.com/docs#part").toString(), "https://example.com/docs");
  await assert.rejects(resolveSafeUrl("https://public.example/docs", async () => ["10.0.0.8"]), { code: "WEB_FETCH_URL_BLOCKED" });
  await assert.rejects(fetchWebEvidence({ url: "https://example.com/start" }, { resolveHostname: PUBLIC,
    fetchImpl: async () => new Response("", { status: 302, headers: { location: "http://127.0.0.1/private" } }) }), { code: "WEB_FETCH_URL_BLOCKED" });
});

test("a read follows revalidated redirects without credentials and returns untrusted readable evidence", async () => {
  const requests = [];
  const evidence = await fetchWebEvidence({ url: "https://example.com/start", maxBytes: 4096 }, { resolveHostname: PUBLIC, now: () => "2026-09-01T00:00:00.000Z",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url === "https://example.com/start") return new Response("", { status: 302, headers: { location: "/article" } });
      const response = new Response("<html><head><title>Example &amp; Notes</title><script>ignore()</script></head><body><nav>Menu</nav><main><h1>Hello</h1><p>Readable <b>page</b>.</p></main></body></html>",
        { headers: { "content-type": "text/html; charset=utf-8" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    } });
  assert.deepEqual(requests.map(request => [request.url, request.init.redirect, request.init.credentials]),
    [["https://example.com/start", "manual", undefined], ["https://example.com/article", "manual", undefined]]);
  assert.equal(evidence.finalUrl, "https://example.com/article");
  assert.equal(evidence.title, "Example & Notes");
  assert.match(evidence.text, /Hello\nReadable page\./);
  assert.doesNotMatch(evidence.text, /ignore|Menu/);
  assert.equal(evidence.trust, "untrusted");
  assert.equal(evidence.fetchedAt, "2026-09-01T00:00:00.000Z");
  assert.match(evidence.contentHash, /^[0-9a-f]{64}$/);
});

test("a read is byte bounded, a stalled body times out and is cancelled, and an HTTP failure is a code", async () => {
  const large = await fetchWebEvidence({ url: "https://example.com/large", maxBytes: 1024 }, { resolveHostname: PUBLIC,
    fetchImpl: async () => new Response("a".repeat(4096), { headers: { "content-type": "text/plain" } }) });
  assert.equal(new TextEncoder().encode(large.text).byteLength, 1024);
  assert.equal(large.truncated, true);
  let cancelled = false;
  await assert.rejects(fetchWebEvidence({ url: "https://example.com/stalled" }, { resolveHostname: PUBLIC, timeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); }, cancel() { cancelled = true; } }),
      { headers: { "content-type": "text/plain" } }) }), { code: "WEB_FETCH_TIMEOUT" });
  assert.equal(cancelled, true);
  await assert.rejects(fetchWebEvidence({ url: "https://example.com/gone" }, { resolveHostname: PUBLIC, fetchImpl: async () => new Response("", { status: 403 }) }),
    error => error.code === "WEB_FETCH_HTTP_ERROR" && error.detail.status === 403);
  // An error's reply says why: an API's JSON answer, a block page's title, and when to retry.
  await assert.rejects(fetchWebEvidence({ url: "https://api.example.com/eval?fen=x" }, { resolveHostname: PUBLIC,
    fetchImpl: async () => Response.json({ error: "No cloud evaluation available for that position" }, { status: 404 }) }),
  error => error.detail.reply === '{"error":"No cloud evaluation available for that position"}'
    && error.message.includes("No cloud evaluation available for that position"));
  await assert.rejects(fetchWebEvidence({ url: "https://example.com/blocked" }, { resolveHostname: PUBLIC,
    fetchImpl: async () => new Response(`<html><head><title>Just a moment...</title><script>${"x".repeat(9000)}</script></head></html>`,
      { status: 429, headers: { "content-type": "text/html", "retry-after": "60" } }) }),
  error => error.detail.reply === "Just a moment..." && error.detail.retryAfter === "60" && error.message.length < 600);
  await assert.rejects(fetchWebEvidence({ url: "https://example.com/doc.pdf" }, { resolveHostname: PUBLIC,
    fetchImpl: async () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }) }),
  error => error.code === "WEB_FETCH_CONTENT_TYPE" && /read_text/.test(error.message));
  await assert.rejects(fetchWebEvidence({ url: "https://example.com/x", maxBytes: 10 }, { resolveHostname: PUBLIC, fetchImpl: async () => new Response("") }), { code: "WEB_FETCH_INPUT_INVALID" });
});

test("an image is evidence only through the product's preview; without one it is an unsupported type", async () => {
  const png = async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  const preview = { mimeType: "image/jpeg", data: "/9j/AAAA" };
  const evidence = await fetchWebEvidence({ url: "https://cdn.example.com/cover.png" }, { resolveHostname: PUBLIC, fetchImpl: png, imagePreview: async () => preview });
  assert.equal(evidence.contentKind, "image");
  assert.deepEqual(evidence.image, preview);
  await assert.rejects(fetchWebEvidence({ url: "https://cdn.example.com/cover.png" }, { resolveHostname: PUBLIC, fetchImpl: png, imagePreview: async () => null }),
    { code: "WEB_FETCH_IMAGE_UNAVAILABLE" });
  await assert.rejects(fetchWebEvidence({ url: "https://cdn.example.com/cover.png" }, { resolveHostname: PUBLIC, fetchImpl: png }), { code: "WEB_FETCH_CONTENT_TYPE" });
});

test("extraction keeps main text past a large navigation, drops unfinished scripts and reads the publication date", async () => {
  const html = `<head><title>Example leadership</title></head><nav>${"<span>Shop</span>".repeat(6000)}</nav><main><h1>Jane Example</h1><p>Chief Executive Officer</p></main><footer>Other links</footer>`;
  const evidence = await fetchWebEvidence({ url: "https://example.com/leadership" }, { resolveHostname: PUBLIC,
    fetchImpl: async () => new Response(html, { headers: { "content-type": "text/html" } }) });
  assert.equal(evidence.text, "Jane Example\nChief Executive Officer");
  await assert.rejects(fetchWebEvidence({ url: "https://example.com/leadership", maxBytes: 12000 }, { resolveHostname: PUBLIC,
    fetchImpl: async () => new Response(html, { headers: { "content-type": "text/html" } }) }), { code: "WEB_FETCH_NO_CONTENT" });
  assert.equal(extractReadableContent("<nav>Menu</nav><main><p>Partial biography</p><script>privatePayload", "text/html").text, "Partial biography");
  assert.equal(extractReadableContent("<style>.x{}</style><noscript>fallback</noscript><h2>Title</h2><p>A &lt; B</p>", "text/html").text, "Title\nA < B");
  const dated = extractReadableContent('<html><head><meta property="article:published_time" content="2026-09-01T10:00:00Z"></head><body><article><h1>News</h1><p>Actual news text.</p></article></body></html>', "text/html");
  assert.equal(dated.publishedAt, "2026-09-01T10:00:00Z");
});

test("search falls back across configured providers, keeps only safe in-domain sources and never leaks keys or bodies", async () => {
  const calls = [];
  const result = await searchWeb({ query: "Apple product", include_domains: ["apple.com"] }, { TAVILY_API_KEY: "fixture-t", BRAVE_API_KEY: "fixture-b" }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, "manual");
      if (url === "https://api.tavily.com/search") return new Response("fixture-t secret response", { status: 429 });
      return Response.json({ web: { results: [
        { title: "Apple newsroom", url: "https://www.apple.com/newsroom/example/", description: "Official", age: "2 days ago" },
        { title: "Private", url: "http://127.0.0.1/admin", description: "not a source" },
        { title: "Other", url: "https://notapple.com/", description: "filtered" }] } });
    } });
  assert.equal(calls[0].init.headers.Authorization, "Bearer fixture-t");
  assert.equal(calls[1].init.headers["X-Subscription-Token"], "fixture-b");
  assert.equal(result.provider, "brave");
  assert.deepEqual(result.items.map(item => [item.url, item.publishedDate]), [["https://www.apple.com/newsroom/example/", "2 days ago"]]);
  assert.deepEqual(result.attempts.filter(item => item.status !== "skipped"), [{ provider: "tavily", status: "error", message: "SEARCH_HTTP_429" }]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-t|fixture-b|secret response/);
});

test("an OpenRouter search is one billed search whose cost is reported even when it brings no evidence", async () => {
  const events = [];
  const annotation = (url, content = "Retrieved excerpt") => ({ type: "url_citation", url_citation: { url, title: "Apple", content } });
  const payload = { id: "gen-fixture", usage: { total_tokens: 100, cost: 0.0071, server_tool_use_details: { web_search_requests: 1 } },
    choices: [{ message: { content: "Made up https://apple.com/invented", annotations: [annotation("https://apple.com/a/"), annotation("https://apple.com/a/"),
      annotation("http://127.0.0.1/private"), annotation("https://apple.com/empty", "")] } }] };
  const fetchImpl = async (url, init) => {
    if (url === "https://api.tavily.com/search") return Response.json({ results: [{ title: "Fallback", url: "https://apple.com/fallback", content: "Other provider" }] });
    const request = JSON.parse(init.body);
    assert.equal(request.max_tool_calls, 1);
    assert.equal(request.tools[0].parameters.max_uses, 1);
    return Response.json(payload);
  };
  const run = keys => searchWeb({ query: "Apple latest", max_results: 3 }, keys, { fetchImpl, onEvent: (event, detail) => events.push({ event, ...detail }) });
  const result = await run({ OPENROUTER_API_KEY: "fixture-or" });
  assert.equal(result.provider, "openrouter");
  assert.deepEqual(result.items.map(item => item.url), ["https://apple.com/a/"]);
  assert.equal(result.providerUsage[0].costUsd, 0.0071);
  assert.equal(result.providerUsage[0].promptTokens, null, "unknown usage is not zero");
  payload.usage.server_tool_use_details.web_search_requests = 0;
  const fallback = await run({ OPENROUTER_API_KEY: "fixture-or", TAVILY_API_KEY: "fixture-t" });
  assert.equal(fallback.provider, "tavily");
  assert.equal(fallback.attempts[0].message, "SEARCH_NOT_EXECUTED");
  assert.equal(fallback.providerUsage[0].costUsd, 0.0071, "the billed search that fell back still reports its cost");
  payload.usage.server_tool_use_details.web_search_requests = 1;
  payload.choices[0].message.annotations = [];
  await assert.rejects(run({ OPENROUTER_API_KEY: "fixture-or" }), error => error.code === "SEARCH_PROVIDERS_FAILED" && error.providerUsage[0].costUsd === 0.0071);
  assert.ok(events.some(event => event.event === "research.provider.usage" && event.costUsd === 0.0071));
  assert.doesNotMatch(JSON.stringify(events), /fixture-or|invented/);
});

test("a search without keys makes no request; invalid input and oversized provider bodies never become results", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("x".repeat(270_000)); };
  await assert.rejects(searchWeb({ query: "Apple" }, {}, { fetchImpl }), { code: "SEARCH_PROVIDER_UNCONFIGURED" });
  assert.equal(calls, 0);
  await assert.rejects(searchWeb({ query: "Apple" }, { TAVILY_API_KEY: "fixture" }, { fetchImpl }), error => error.code === "SEARCH_PROVIDERS_FAILED" && !error.message.includes("xxxx"));
  assert.equal(calls, 1);
  for (const input of [{ query: "Apple", url: "https://evil.example" }, { query: " " }, { query: "a", max_results: 11 }, { query: "a", include_domains: ["not a domain"] }]) {
    assert.throws(() => webSearchInput(input), { code: "WEB_SEARCH_INPUT_INVALID" });
  }
  assert.deepEqual(webSearchInput({ query: " Apple " }), { query: "Apple", max_results: 5 });
});
