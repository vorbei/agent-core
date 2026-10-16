import assert from "node:assert/strict";
import test from "node:test";
import { chatMarkdown, splitTightStrongFallback } from "../../src/ui/markdown.js";
import { parseHTML } from "linkedom";

function inlineParts(source) {
  return chatMarkdown.lexer(source)[0].tokens.flatMap((token) => token.type === "text"
    ? splitTightStrongFallback(token.text)
    : [{ type: token.type, text: token.text }]);
}

test("recovers Chinese strong labels that CommonMark leaves literal", () => {
  assert.deepEqual(inlineParts("**证据范围：**当前账号"), [
    { type: "strong", text: "证据范围：" },
    { type: "text", text: "当前账号" }
  ]);
  assert.deepEqual(inlineParts("**证据范围： **当前账号"), [
    { type: "strong", text: "证据范围：" },
    { type: "text", text: " 当前账号" }
  ]);
});

test("bare links stop at Chinese prose punctuation without discarding the explanation", () => {
  for (const suffix of ['（链接文字为 "Learn more"）', '，查看这里', '。下一句', '；说明', '！', '？', '【说明】', '「说明」']) {
    const url = "https://iana.org/domains/example";
    const { document } = parseHTML(chatMarkdown.parse(url + suffix));
    assert.equal(document.querySelector("a").getAttribute("href"), url);
    assert.equal(document.querySelector("p").textContent, url + suffix);
  }
  const { document } = parseHTML(chatMarkdown.parse("- https://example.com/中文?q=增长#章节（说明）\n\n| 来源 |\n| --- |\n| www.example.com。说明 |"));
  assert.deepEqual([...document.querySelectorAll("a")].map(a => a.getAttribute("href")), [
    "https://example.com/%E4%B8%AD%E6%96%87?q=%E5%A2%9E%E9%95%BF#%E7%AB%A0%E8%8A%82", "http://www.example.com"
  ]);
});

test("explicit links, encoded punctuation, balanced ASCII parentheses and code retain their targets", () => {
  const url = "https://example.com/条目（说明）";
  for (const source of [`[原文](${url})`, `<${url}>`, `[原文][ref]\n\n[ref]: ${url}`]) {
    const { document } = parseHTML(chatMarkdown.parse(source));
    assert.equal(decodeURI(document.querySelector("a").getAttribute("href")), url);
  }
  for (const url of ["https://example.com/a%EF%BC%88b%EF%BC%89", "https://example.com/wiki/Test_(example)", "https://example.com/?a=1&b=2"]) {
    const { document } = parseHTML(chatMarkdown.parse(url));
    assert.equal(document.querySelector("a").getAttribute("href"), url);
  }
  const { document } = parseHTML(chatMarkdown.parse('`https://example.com（代码）`\n\n```\nhttps://example.com（代码）\n```'));
  assert.equal(document.querySelectorAll("a").length, 0);
});

test("recovers multiple tight labels without changing their text", () => {
  assert.deepEqual(inlineParts("**证据：**当前；**来源：**X 搜索"), [
    { type: "strong", text: "证据：" },
    { type: "text", text: "当前；" },
    { type: "strong", text: "来源：" },
    { type: "text", text: "X 搜索" }
  ]);
});

test("leaves arithmetic and escaped or code-delimited Markdown alone", () => {
  assert.deepEqual(splitTightStrongFallback("2 ** 3 ** 4"), [
    { type: "text", text: "2 ** 3 ** 4" }
  ]);
  assert.deepEqual(inlineParts(String.raw`\**证据范围：**当前账号`), [
    { type: "escape", text: "*" },
    { type: "text", text: "*证据范围：**当前账号" }
  ]);
  assert.deepEqual(inlineParts("`**证据范围：**当前账号`"), [
    { type: "codespan", text: "**证据范围：**当前账号" }
  ]);
});
