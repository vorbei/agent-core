// A stand-in for the Worker Loader binding in Node tests only: it runs the sandbox module that
// runSandboxedCode builds in a node:vm context with no fetch, no require and no process. node:vm is
// not a security boundary, and this loader enforces neither `globalOutbound` nor `limits.cpuMs`;
// it exists so unit tests can exercise the module's own behavior (value, logs, caps, errors,
// timeout). Never imported by product code: the Worker uses its real `worker_loaders` binding,
// which `wrangler dev` provides locally too. Development only.
import vm from "node:vm";

/**
 * @param {{ onLoad?: (code: any) => void }} [options] `onLoad` sees what the product asked the loader for.
 * @returns {import("../src/runtime/index.js").CodeLoader}
 */
export function testCodeLoader({ onLoad } = {}) {
  return {
    load(code) {
      onLoad?.(code);
      const source = code.modules[code.mainModule].js
        .replace(/^import \{ WorkerEntrypoint \} from "cloudflare:workers";$/m, "")
        .replace("export default class extends WorkerEntrypoint", "__module.default = class extends WorkerEntrypoint");
      class WorkerEntrypoint { constructor(/** @type {unknown} */ env) { this.env = env; } }
      const context = vm.createContext({ __module: {}, WorkerEntrypoint, setTimeout, clearTimeout });
      return {
        getEntrypoint() {
          return {
            async run(options) {
              // Compiling here, like the platform's first call, makes a syntax error a failed run.
              vm.runInContext(source, context);
              const Entrypoint = context.__module.default;
              // Results cross back from the vm's realm as plain data, as they would over RPC.
              return structuredClone(await new Entrypoint(code.env).run(options));
            },
          };
        },
      };
    },
  };
}
