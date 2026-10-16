// The code Worker's runtime in a Node worker thread, for the code sandbox tests: a stand-in for the
// sandboxed page's blob Worker (no CSP here; the tests check what the runtime itself removes).
// `workerData.shell`: "fake" serves bash with a scripted shell that records how it was made.
import { parentPort, workerData } from "node:worker_threads";
import { serveCodeRun } from "../../src/browser/code-worker.js";

// What an extension page would expose; the runtime must remove it before the code runs.
globalThis.chrome = { runtime: { id: "extension" }, storage: {} };

class FakeShell {
  constructor(options) { this.options = options; }
  async exec(script) {
    if (script === "options") return { stdout: JSON.stringify(this.options), stderr: "", exitCode: 0 };
    if (script === "fail") return { stdout: "partial\n", stderr: "boom\n", exitCode: 2 };
    if (script === "loud") return { stdout: "o".repeat(30_000), stderr: "e".repeat(5_000), exitCode: 0 };
    throw new Error(`unexpected script ${script}`);
  }
}

serveCodeRun(globalThis, { port: parentPort, Bash: workerData?.shell === "fake" ? FakeShell : undefined });
