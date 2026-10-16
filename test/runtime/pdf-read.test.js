import { test } from "node:test";
import assert from "node:assert/strict";
import { PdfReadError, publicPdfUrl, readPdf } from "../../src/runtime/index.js";

// What Workers AI toMarkdown returns for a PDF: a title, a metadata list, then one "### Page N" per page.
const CONVERTED = "# document.pdf\n## Metadata\n- Title=Attention budgets\n\n## Contents\n### Page 1\nAbstract.\n### Page 2\nRelated work.\n### Page 3\nResults.";
const PDF = new TextEncoder().encode("%PDF-1.7 fixture");

function server(routes, converted = CONVERTED) {
  const fetched = [], conversions = [];
  return {
    fetched, conversions,
    fetch: async (url, init) => {
      fetched.push({ url, init });
      if (!routes[url]) throw new TypeError("fetch failed");
      return routes[url]();
    },
    toMarkdown: async files => { conversions.push(files); return [{ format: "markdown", data: converted }]; },
  };
}
const pdf = () => new Response(PDF, { headers: { "Content-Type": "application/pdf" } });

test("a PDF is read page by page from the page its URL names, titled by its metadata", async () => {
  const s = server({ "https://papers.example/a.pdf": pdf });
  assert.deepEqual(await readPdf("https://papers.example/a.pdf", s), { title: "Attention budgets", pages: 3, from: 1, firstPage: 1,
    text: "--- page 1 ---\nAbstract.\n\n--- page 2 ---\nRelated work.\n\n--- page 3 ---\nResults." });
  assert.deepEqual(await readPdf("https://papers.example/a.pdf#page=3", s), { title: "Attention budgets", pages: 3, from: 3, firstPage: 3,
    text: "--- page 3 ---\nResults." });
  assert.equal((await readPdf("https://papers.example/a.pdf", { ...s, maxChars: 5 })).text, "--- page 1 ---\nAbstract.");
  // No fragment and no credential is sent; redirects are followed by hand.
  assert.equal(s.fetched[0].url, "https://papers.example/a.pdf");
  assert.equal(s.fetched[0].init.redirect, "manual");
  assert.doesNotMatch(JSON.stringify(s.fetched[0].init.headers), /cookie|authorization/i);
});

test("a conversion without page boundaries is one block without its metadata", async () => {
  const s = server({ "https://papers.example/a.pdf": pdf }, "# document.pdf\n## Metadata\n- Creator=Writer\n\n## Contents\nJust text");
  assert.deepEqual(await readPdf("https://papers.example/a.pdf#page=2", s), { title: null, pages: null, from: 2, firstPage: null, text: "Just text" });
});

test("a cached conversion is read again without a fetch or a conversion; a failure is not cached", async () => {
  const stored = new Map();
  const cache = { get: async url => stored.get(url) ?? null, put: async (url, markdown) => { stored.set(url, markdown); } };
  const s = server({ "https://papers.example/a.pdf": pdf, "https://papers.example/denied.pdf": () => new Response("no", { status: 403 }) });
  await readPdf("https://papers.example/a.pdf#page=1", { ...s, cache });
  assert.equal((await readPdf("https://papers.example/a.pdf#page=2", { ...s, cache })).firstPage, 2);
  assert.deepEqual([s.fetched.length, s.conversions.length, [...stored.keys()]], [1, 1, ["https://papers.example/a.pdf"]]);
  await assert.rejects(readPdf("https://papers.example/denied.pdf", { ...s, cache }), { code: "PDF_FETCH_FAILED", stage: "fetch" });
  assert.equal(stored.size, 1);
});

test("what cannot be read fails with a code and a stage, and nothing is converted before the bytes are a PDF", async () => {
  const s = server({
    "https://papers.example/portal.pdf": () => new Response("<html>Sign in</html>"),
    "https://papers.example/big.pdf": () => new Response(PDF, { headers: { "Content-Length": String(31 * 1024 * 1024) } }),
    "https://papers.example/to-intranet.pdf": () => new Response(null, { status: 302, headers: { Location: "http://10.0.0.8/a.pdf" } }),
    "https://papers.example/a.pdf": pdf,
  });
  await assert.rejects(readPdf("https://papers.example/portal.pdf", s), { code: "PDF_INVALID", stage: "fetch" });
  await assert.rejects(readPdf("https://papers.example/big.pdf", s), { code: "PDF_TOO_LARGE" });
  await assert.rejects(readPdf("https://papers.example/to-intranet.pdf", s), { code: "PDF_URL_INVALID" });
  await assert.rejects(readPdf("http://127.0.0.1/a.pdf", s), { code: "PDF_URL_INVALID" });
  await assert.rejects(readPdf("https://unreachable.example/a.pdf", s), { code: "PDF_FETCH_FAILED" });
  assert.equal(s.conversions.length, 0);
  await assert.rejects(readPdf("https://papers.example/a.pdf", { ...s, toMarkdown: null }), { code: "PDF_CONVERTER_MISSING", stage: "convert" });
  await assert.rejects(readPdf("https://papers.example/a.pdf", { ...s, toMarkdown: async () => [{ format: "markdown", data: " " }] }), { code: "PDF_NO_TEXT" });
  await assert.rejects(readPdf("https://papers.example/a.pdf", { ...s, toMarkdown: async () => { throw new Error("busy"); } }), { code: "PDF_CONVERSION_FAILED" });
  assert.ok(new PdfReadError("PDF_X", "fetch", "why") instanceof Error);
  assert.equal(publicPdfUrl("http://127.0.0.1:8/a.pdf#page=2", { allowLoopback: true }), "http://127.0.0.1:8/a.pdf");
});
