// Build time only: the code sandbox's two bundles a product ships or serves. `buildCodeSandboxScript`
// is the sandboxed page's script (code-sandbox.js beside CODE_SANDBOX_PAGE) with its own Worker for
// JavaScript runs inlined as text; `buildShellSandbox` is the shell Worker of bash runs (the core's
// code runtime with the product's just-bash), which the product's server serves under a
// content address and its extension pins by SHA-256. The product passes its esbuild `build` and the
// entry modules, so its own packages are resolved and the same sources give the same bytes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BROWSER = { bundle: true, format: "iife", platform: "browser", target: "chrome116", minify: true, sourcemap: false, legalComments: "none", logLevel: "warning", write: false };

// Node built-ins are absent in the browser: just-bash imports node:zlib only for gzip, which then
// fails as a command error.
const nodeBuiltins = {
  name: "node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, args => ({ path: args.path, namespace: "node-builtin" }));
    build.onLoad({ filter: /.*/, namespace: "node-builtin" }, args => ({ loader: "js",
      contents: `const unavailable = () => { throw new Error(${JSON.stringify(`${args.path} is not available in the browser`)}); };
export default new Proxy({}, { get: () => unavailable });
export const constants = {};
export const gzipSync = unavailable, gunzipSync = unavailable, deflateSync = unavailable, inflateSync = unavailable;` }));
  },
};

/**
 * The sandboxed page's script: `pageEntry` calls `serveCodeSandboxPage(window, { workerSource:
 * CODE_WORKER_SOURCE })`, and `workerEntry` (`serveCodeRun(self)`, JavaScript runs) is bundled as
 * that text.
 * @returns {Promise<string>}
 */
export async function buildCodeSandboxScript({ build, pageEntry, workerEntry, root }) {
  const worker = await build({ ...BROWSER, entryPoints: [workerEntry], absWorkingDir: root });
  const page = await build({ ...BROWSER, entryPoints: [pageEntry], absWorkingDir: root,
    define: { CODE_WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text) } });
  return page.outputFiles[0].text;
}

/**
 * The shell Worker's bundle from `entry` (a module calling `serveCodeRun(self, { Bash })` with
 * just-bash's browser build), named `<pathPrefix>just-bash-<version>-<sha256>.js`; `license` is
 * the path of just-bash's license file, which the server serves beside it.
 * @returns {Promise<{ text: string, sha256: string, version: string, path: string, license: string }>}
 */
export async function buildShellSandbox({ build, entry, root, pathPrefix }) {
  const dir = packageDir(root, "just-bash");
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const result = await build({ ...BROWSER, entryPoints: [entry], absWorkingDir: root,
    banner: { js: `/*! run_code shell Worker: agent-core's code runtime and just-bash ${version} (Apache-2.0, ${pathPrefix}just-bash-LICENSE.txt) */` },
    plugins: [nodeBuiltins] });
  const text = result.outputFiles[0].text;
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  return { text, sha256, version, path: `${pathPrefix}just-bash-${version}-${sha256}.js`, license: join(dir, "LICENSE") };
}

// The installed package's directory as Node resolves it from `root` (its package.json need not be exported).
function packageDir(root, name) {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return join(dir, "node_modules", name);
    if (dirname(dir) === dir) throw new Error(`${name} is not installed under ${root}`);
  }
}
