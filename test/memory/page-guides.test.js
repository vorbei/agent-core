import { test } from "node:test";
import assert from "node:assert/strict";
import { bundledAppGuide, bundledPageGuide, pathCovers } from "../../src/memory/index.js";

const DOMAINS = [{ domains: ["arxiv.org"], pages: [{ name: "arxiv-advanced-search", paths: ["/search/advanced"], content: " Choose the original date. \n", verifiedOn: "2026-10-08" }] }];

test("a page guide is selected by host (subdomains included) and path prefix", () => {
  assert.deepEqual(bundledPageGuide(DOMAINS, "https://arxiv.org/search/advanced?terms-0-term=x"), {
    id: "bundled:arxiv-advanced-search", source: "bundled", host: "arxiv.org", pathPrefix: "/search/advanced", content: "Choose the original date.", since: "2026-10-08" });
  assert.equal(bundledPageGuide(DOMAINS, "https://export.arxiv.org/search/advanced/")?.host, "export.arxiv.org");
  assert.equal(bundledPageGuide(DOMAINS, "https://arxiv.org/abs/2005.11401"), null);
  assert.equal(bundledPageGuide(DOMAINS, "https://notarxiv.org/search/advanced"), null);
  assert.equal(bundledPageGuide(DOMAINS, "not a url"), null);
});

test("a page's own guide wins over a site-wide one, whatever their order", () => {
  const site = { name: "site", paths: ["/"], content: "Site." };
  const editor = { name: "editor", paths: ["/compose/articles"], content: "Editor." };
  for (const pages of [[site, editor], [editor, site]]) {
    const domains = [{ domains: ["example.com"], pages }];
    assert.equal(bundledPageGuide(domains, "https://example.com/compose/articles/edit/1")?.id, "bundled:editor");
    assert.deepEqual([bundledPageGuide(domains, "https://example.com/home")?.id, bundledPageGuide(domains, "https://example.com/")?.pathPrefix],
      ["bundled:site", "/"]);
  }
});

test("a path prefix covers itself and what is below it, not a longer sibling", () => {
  assert.equal(pathCovers("/search", "/search/advanced"), true);
  assert.equal(pathCovers("/search/", "/search/x"), true);
  assert.equal(pathCovers("/search", "/searchable"), false);
});

test("an app guide is chosen only for its app in front on its page, and never as the page's own guide", () => {
  const page = { name: "phone", paths: ["/phone"], content: "Operate the phone." };
  const app = { name: "phone-app-chess", paths: ["/phone"], apps: ["com.example.chess"], content: "The board is drawn.", verifiedOn: "2026-10-13" };
  for (const pages of [[page, app], [app, page]]) {
    const domains = [{ domains: ["127.0.0.1"], pages }];
    assert.equal(bundledPageGuide(domains, "http://127.0.0.1:8200/phone")?.id, "bundled:phone");
    assert.deepEqual(bundledAppGuide(domains, "http://127.0.0.1:8200/phone", "com.example.chess"), {
      id: "bundled:phone-app-chess", source: "bundled", host: "127.0.0.1", pathPrefix: "/phone", content: "The board is drawn.", since: "2026-10-13",
      app: "com.example.chess" });
    assert.equal(bundledAppGuide(domains, "http://127.0.0.1:8200/phone", "com.apple.Preferences"), null, "another app in front");
    assert.equal(bundledAppGuide(domains, "http://127.0.0.1:8200/phone", null), null, "the app in front is not known");
    assert.equal(bundledAppGuide(domains, "http://127.0.0.1:8200/other", "com.example.chess"), null, "another page");
  }
});
