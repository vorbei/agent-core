import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWER_LENGTH_RULE, contextLine, OUTPUT_LIMIT_NOTICE, PENDING_ACTION_STEER, planRules } from "../../src/guidance/index.js";

test("the planning rules name the product's own code tool and refuse a missing one", () => {
  const rules = planRules({ compute: "run_code" });
  assert.ok(rules.split("\n").every(line => line.startsWith("- ")), "one list line per rule");
  assert.ok(rules.includes('"run_code"'));
  assert.ok(!planRules({ compute: "js_exec" }).includes("run_code"), "nothing names another product's tool");
  for (const compute of [undefined, "", "run code", "Run_Code"]) assert.throws(() => planRules({ compute }), TypeError);
  assert.equal(typeof ANSWER_LENGTH_RULE, "string");
});

test("the pending-action steer carries the claim placeholder the Pi layer fills; the output-limit notice is text", () => {
  assert.equal(PENDING_ACTION_STEER.split("{{CLAIM}}").length, 2, "exactly one claim placeholder");
  assert.equal(typeof OUTPUT_LIMIT_NOTICE, "string");
});

test("the context line names the product's tab reference and escapes what the page controls", () => {
  assert.equal(contextLine({ tabId: 7, url: "https://a.example/?x=1&y=2", title: 'Say "hi" <b>' }),
    '<browser_context tabId="7" url="https://a.example/?x=1&amp;y=2" title="Say &quot;hi&quot; &lt;b>"/>');
  assert.match(contextLine({ tabId: "t7", url: "https://a.example/", title: "" }), /tabId="t7"/);
  assert.equal(contextLine(null), "<browser_context>no tab selected</browser_context>");
});
