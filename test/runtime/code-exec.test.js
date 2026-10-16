import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_EXEC_LIMITS, createTurnBudget, runSandboxedCode } from "../../src/runtime/index.js";
import { testCodeLoader } from "../../tools/test-code-loader.js";

const run = (code, options = {}) => runSandboxedCode({ loader: testCodeLoader(), code, ...options });

test("code runs as an async function body: the returned value as text, console lines as logs", async () => {
  assert.deepEqual(await run("console.log('n', 3); return [1, 2, 3].reduce((a, b) => a + b, 0) * 7;"),
    { ok: true, value: "42", logs: ["n 3"], truncated: false, calls: 0 });
  assert.equal((await run("return 'plain text';")).value, "plain text");
  assert.equal((await run("return { a: [1, { b: null }] };")).value, '{"a":[1,{"b":null}]}');
  assert.equal((await run("await new Promise(resolve => setTimeout(resolve, 5)); return undefined;")).value, "undefined");
  assert.equal((await run("return 10n ** 20n;")).value, "100000000000000000000");
});

test("a throw, a syntax error and an unknown name are failed results, with the logs before them", async () => {
  const thrown = await run("console.log('before'); throw new RangeError('bad input');");
  assert.deepEqual(thrown, { ok: false, error: { code: "CODE_ERROR", message: "bad input", name: "RangeError" }, logs: ["before"], truncated: false, calls: 0 });
  const syntax = await run("return (;");
  assert.equal(syntax.ok, false);
  assert.equal(syntax.error.code, "CODE_ERROR");
  assert.equal(syntax.error.name, "SyntaxError");
  const unknown = await run("return undefinedName + 1;");
  assert.match(unknown.error.message, /undefinedName/);
});

test("a run that does not finish in time is EXEC_TIMEOUT and keeps its logs", async () => {
  const started = Date.now();
  const result = await run("console.log('waiting'); await new Promise(() => {});", { timeoutMs: 150 });
  assert.deepEqual(result, { ok: false, error: { code: "EXEC_TIMEOUT", message: "EXEC_TIMEOUT" }, logs: ["waiting"], truncated: false, calls: 0 });
  assert.ok(Date.now() - started < 2_000);
});

test("an isolate that never answers is abandoned by the host after the timeout", async () => {
  const loader = { load: () => ({ getEntrypoint: () => ({ run: () => new Promise(() => {}) }) }) };
  const result = await runSandboxedCode({ loader, code: "return 1;", timeoutMs: 100 });
  assert.deepEqual(result.error, { code: "EXEC_TIMEOUT", message: "EXEC_TIMEOUT" });
});

test("a platform CPU stop is EXEC_CPU_LIMIT", async () => {
  const loader = { load: () => ({ getEntrypoint: () => ({ run: async () => { throw new Error("Worker exceeded CPU time limit."); } }) }) };
  assert.equal((await runSandboxedCode({ loader, code: "while (true) {}" })).error.code, "EXEC_CPU_LIMIT");
});

test("the value and the logs are capped, and say so", async () => {
  const big = await run("return 'x'.repeat(50_000);", { maxOutputChars: 2_000 });
  assert.equal(big.value.length, 2_000);
  assert.equal(big.truncated, true);
  const chatty = await run("for (let i = 0; i < 100; i++) console.log('y'.repeat(900)); return 1;");
  assert.equal(chatty.logs.length, CODE_EXEC_LIMITS.logLines + 1);
  assert.ok(chatty.logs.slice(0, -1).every(line => line.length === CODE_EXEC_LIMITS.logLineChars && line.endsWith("…")));
  assert.equal(chatty.logs.at(-1), `[${100 - CODE_EXEC_LIMITS.logLines} more log lines dropped]`);
  assert.equal(chatty.truncated, false, "the value itself was not cut");
  // Requested bounds are clamped: a huge output cap stays at the maximum.
  assert.equal((await run("return 'z'.repeat(100_000);", { maxOutputChars: 10_000_000 })).value.length, CODE_EXEC_LIMITS.maxOutputChars);
});

test("the isolate gets no network, no bindings and a CPU limit unless the product passes tools", async () => {
  let asked;
  const result = await runSandboxedCode({ loader: testCodeLoader({ onLoad: code => { asked = code; } }), code: "return typeof fetch;", timeoutMs: 5_000 });
  assert.equal(asked.globalOutbound, null, "fetch, connect and WebSocket are refused by the platform");
  assert.deepEqual(asked.env, {});
  assert.deepEqual(asked.limits, { cpuMs: 5_000 });
  assert.equal(result.value, "undefined");
  // Without tools, every nested call is refused.
  assert.match((await run("return await tools.get_status();")).error.message, /TOOL_NOT_ALLOWED: get_status/);
});

test("a long wall-clock timeout does not lend the isolate that much CPU: its caller waits while it computes", async () => {
  let asked;
  const loader = testCodeLoader({ onLoad: code => { asked = code; } });
  await runSandboxedCode({ loader, code: "return 1;", timeoutMs: CODE_EXEC_LIMITS.maxTimeoutMs });
  assert.equal(asked.limits.cpuMs, CODE_EXEC_LIMITS.cpuMs);
  assert.ok(CODE_EXEC_LIMITS.cpuMs <= 5_000, "a computing isolate holds its Durable Object for seconds, not minutes");
  await runSandboxedCode({ loader, code: "return 1;", timeoutMs: 200 });
  assert.equal(asked.limits.cpuMs, 200, "a shorter timeout is the tighter bound");
});

test("nested tools reach only the product's binding, by its allowed names and up to its call limit", async () => {
  const seen = [];
  const binding = { call: async (name, input) => { seen.push([name, input]); return { ok: true, data: name }; } };
  const tools = { binding, bindingName: "PRODUCT", names: ["read_a"], maxCalls: 2 };
  let asked;
  const loader = testCodeLoader({ onLoad: code => { asked = code; } });
  const ok = await runSandboxedCode({ loader, code: "return [await tools.read_a({ q: 1 }), await tools.read_a()];", tools });
  assert.deepEqual(Object.keys(asked.env), ["PRODUCT"]);
  assert.deepEqual(JSON.parse(ok.value), [{ ok: true, data: "read_a" }, { ok: true, data: "read_a" }]);
  assert.equal(ok.calls, 2);
  assert.equal(JSON.stringify(seen), JSON.stringify([["read_a", { q: 1 }], ["read_a", {}]]));
  assert.match((await runSandboxedCode({ loader, code: "return await tools.write_b();", tools })).error.message, /TOOL_NOT_ALLOWED: write_b/);
  assert.match((await runSandboxedCode({ loader, code: "for (let i = 0; i < 3; i++) await tools.read_a(); return 1;", tools })).error.message, /NESTED_TOOL_LIMIT/);
});

test("invalid input throws with a stable code before anything is loaded", async () => {
  for (const [request, code] of [
    [{ loader: null, code: "return 1;" }, "CODE_MODE_UNAVAILABLE"],
    [{ loader: testCodeLoader(), code: "  " }, "CODE_REQUIRED"],
    [{ loader: testCodeLoader(), code: "x".repeat(CODE_EXEC_LIMITS.maxCodeChars + 1) }, "CODE_TOO_LARGE"],
  ]) await assert.rejects(runSandboxedCode(request), error => error.code === code);
});

test("a turn's code runs are a keyed budget whose ceiling the product may set", () => {
  const budget = createTurnBudget({}, { maxModelCalls: 5, maxToolCalls: 5, maxCodeExecCalls: 3 });
  for (const key of ["a", "b", "c"]) assert.equal(budget.reserve("codeExec", key).ok, true);
  assert.equal(budget.reserve("codeExec", "a").duplicate, true, "a replayed call counts once");
  assert.equal(budget.reserve("codeExec", "d").ok, false);
  // Restored from its snapshot, the turn keeps what it used.
  assert.equal(createTurnBudget(budget.snapshot(), { maxModelCalls: 5, maxToolCalls: 5, maxCodeExecCalls: 3 }).reserve("codeExec", "e").ok, false);
  assert.equal(createTurnBudget({}, { maxModelCalls: 5, maxToolCalls: 5 }).remaining("codeExec"), 2, "the default ceiling is unchanged");
});
