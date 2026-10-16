// Runs Node with the Worker build's Pi stubs in place: `node --import agent-core/tools/worker-stubs.js`
// registers module hooks that load each module named in PI_WORKER_STUBS as its throwing stub, and
// fails the process (exit code 1) if anything used a stub, even where the error was caught. A test
// suite that passes this way never reaches a stubbed module. Development only.
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";
import { exportNames, stubFor, stubSource } from "./worker-bundle.js";

// A stub's export names are read from the original module, loaded (with everything it imports)
// under this marker as a separate, unstubbed module graph.
const ORIGINAL = "pi-worker-original";

const marked = url => url.startsWith("file:") && new URL(url).searchParams.has(ORIGINAL);

/** Module hook: an import made by an original keeps the marker. */
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (!context.parentURL || !marked(context.parentURL) || !result.url.startsWith("file:") || marked(result.url)) return result;
  const url = new URL(result.url);
  url.searchParams.set(ORIGINAL, "");
  return { ...result, url: url.href };
}

/** Module hook: a stubbed module's source is its stub. */
export async function load(url, context, nextLoad) {
  const stub = url.startsWith("file:") && !marked(url) ? stubFor(new URL(url).pathname) : undefined;
  if (!stub) return nextLoad(url, context);
  const original = new URL(url);
  original.searchParams.set(ORIGINAL, "");
  return { format: "module", shortCircuit: true, source: stubSource(stub.path, await exportNames(original.href)) };
}

if (isMainThread) {
  // module.register is deprecated in favour of the synchronous registerHooks, but a stub's export
  // names come from an asynchronous load of the original; keep the notice out of every test's output.
  const noDeprecation = process.noDeprecation;
  process.noDeprecation = true;
  register(import.meta.url);
  process.noDeprecation = noDeprecation;
  process.on("exit", () => {
    const calls = globalThis.__piWorkerStubCalls ?? [];
    if (!calls.length) return;
    console.error(`PI_WORKER_STUB: a stubbed module was used: ${[...new Set(calls)].join(", ")}`);
    process.exitCode = 1;
  });
}
