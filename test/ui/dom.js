// Test helper: the chat UI (JSX) bundled with esbuild for node, rendered by React into a linkedom
// document. React stays external so the test and the bundle share one React.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);

/** The chat UI module (src/ui/index.jsx) as a CommonJS module sharing this process's React. */
export async function loadChatUi() {
  const entry = fileURLToPath(new URL("../../src/ui/index.jsx", import.meta.url));
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "cjs",
    jsx: "automatic", external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], logLevel: "silent" });
  const module = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

/** A document with the browser globals React and the chat use; `restore()` puts the old ones back. */
export function browserGlobals(html = "<html><body><main></main></body></html>") {
  const { document, window } = parseHTML(html);
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const names = ["window", "document", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "navigator"];
  const originals = Object.fromEntries(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const confirmations = [];
  window.confirm = (message) => { confirmations.push(message); return true; };
  for (const [name, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (run) => setTimeout(run, 0) }))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return {
    document, window, confirmations,
    restore() {
      for (const [name, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

export const React = require("react");
export const { act } = React;
export const { renderToStaticMarkup } = require("react-dom/server");
