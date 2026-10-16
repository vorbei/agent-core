// The Worker build of pi-coding-agent that every consumer bundles: the installed package is staged
// under `<root>/.wrangler/pi` (each module's `import.meta.url`, undefined in workerd, mapped to its
// own /bundle path; the package resources Pi reads at load attached to the entry), the modules no
// Worker code path runs are replaced by stubs that throw when used, and the Wrangler aliases and
// the Wrangler module rule the consumers' configs share are defined here.
// Installed sources in node_modules stay untouched. Build-time only; never imported by a Worker.
import { constants } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const PI = "node_modules/@earendil-works/pi-coding-agent";

/** Package files Pi reads at load, bundled as Text modules. */
export const PI_RESOURCES = ["package.json", "README.md", "docs/sdk.md", "docs/extensions.md",
  "dist/modes/interactive/theme/dark.json", "dist/modes/interactive/theme/light.json"];

// Modules no Worker code path runs, named by their path inside a package (the text after the last
// `node_modules/`), so one entry covers every installed copy. A Worker session is created with no
// file extensions, skills, prompt templates, themes, context files or built-in tools, streams
// through the host's own provider function, and never renders a terminal UI. `--import
// agent-core/tools/worker-stubs.js` loads the same stubs in Node, and a test run that touches one
// fails (worker-stubs.js).
export const PI_WORKER_STUBS = [
  // The CLI and the terminal UI (pi-tui components, mermaid, the session pickers).
  { path: "@earendil-works/pi-coding-agent/dist/main.js", why: "the pi CLI entry" },
  { path: "@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js", why: "the terminal UI" },
  { path: "@earendil-works/pi-coding-agent/dist/modes/interactive/components/index.js", why: "terminal UI components" },  // highlight.js: code highlighting for terminal and HTML export rendering.
  { path: "@earendil-works/pi-coding-agent/dist/utils/syntax-highlight.js", why: "terminal and HTML-export code highlighting" },
  // jiti: compiles TypeScript extension files from disk; Worker extensions are factories.
  { path: "jiti/lib/jiti-static.mjs", why: "loading extension files from disk" },
  // undici: the CLI's proxy-aware global dispatcher; a Worker uses its platform fetch.
  { path: "undici/index.js", why: "the CLI's HTTP dispatcher" },
  // photon: image conversion and resizing; a failed load is Pi's own "image omitted" path.
  { path: "@silvia-odwyer/photon-node/photon_rs.js", why: "image conversion (WebAssembly)" },
  // yaml: frontmatter of skills and prompt templates, which a Worker session does not load.
  { path: "yaml/browser/index.js", why: "skill and prompt-template frontmatter" },
  { path: "yaml/dist/index.js", why: "skill and prompt-template frontmatter" },
  // pi-ai's built-in API implementations other than OpenAI completions, loaded on demand by the
  // built-in providers; a Worker session streams through the host's registered provider.
  ...["anthropic-messages", "azure-openai-responses", "bedrock-converse-stream", "google-generative-ai",
    "google-vertex", "mistral-conversations", "openai-codex-responses", "openai-responses", "openrouter-images"]
    .map(api => ({ path: `@earendil-works/pi-ai/dist/api/${api}.js`, why: "a built-in model API the host does not stream through" })),
];

/**
 * Paths deleted from the staged tree: photon's WebAssembly, which only the stubbed module loads,
 * and Pi's examples, which nothing imports (Wrangler would attach their WebAssembly as modules).
 */
export const PI_WORKER_REMOVED = ["@silvia-odwyer/photon-node/photon_rs_bg.wasm", "@earendil-works/pi-coding-agent/examples"];

/** The stub entry for a file path or URL, if it is one. */
export function stubFor(path) {
  const normalized = String(path).replace(/\\/g, "/");
  const index = normalized.lastIndexOf("node_modules/");
  if (index < 0) return undefined;
  const inPackage = normalized.slice(index + "node_modules/".length);
  return PI_WORKER_STUBS.find(stub => stub.path === inPackage);
}

/**
 * Source of a stub module exporting `names`: each export is a function-shaped value that throws
 * `PI_WORKER_STUB` (and records itself in `globalThis.__piWorkerStubCalls`) on any use: a call,
 * `new`, or any property read or reflection. Binding an import does not use it.
 */
export function stubSource(label, names) {
  const exported = [...new Set(names)].filter(name => name !== "module.exports");
  return `// Stub from agent-core/tools/worker-bundle.js: ${label} is not part of the Worker build.\n` +
    `const stub = name => {\n` +
    `  const fail = () => {\n` +
    `    const where = ${JSON.stringify(label)} + "#" + name;\n` +
    `    (globalThis.__piWorkerStubCalls ??= []).push(where);\n` +
    `    const error = new Error("PI_WORKER_STUB: " + where + " is stubbed out of the Worker build (agent-core/tools/worker-bundle.js)");\n` +
    `    error.code = "PI_WORKER_STUB";\n` +
    `    throw error;\n` +
    `  };\n` +
    `  return new Proxy(function () {}, { apply: fail, construct: fail, get: fail, set: fail, has: fail, ownKeys: fail,\n` +
    `    getPrototypeOf: fail, setPrototypeOf: fail, defineProperty: fail, deleteProperty: fail,\n` +
    `    getOwnPropertyDescriptor: fail, isExtensible: fail, preventExtensions: fail });\n` +
    `};\n` +
    exported.map((name, index) => `const s${index} = stub(${JSON.stringify(name)});\n`).join("") +
    `export { ${exported.map((name, index) => `s${index} as ${JSON.stringify(name)}`).join(", ")} };\n`;
}

/** The export names of the installed module at `url` (it is loaded in this process to read them). */
export async function exportNames(url) {
  return Object.keys(await import(url));
}

/**
 * Stages pi-coding-agent from `<root>/node_modules` into `<root>/.wrangler/pi` and writes one
 * entry module per `entries` item (`name` → the Worker module it re-exports, relative to
 * `.wrangler/pi`), each carrying Pi's package resources. `transform` is esbuild's.
 */
export async function stagePi({ root, transform, entries }) {
  const target = join(root, ".wrangler/pi");
  const staged = join(target, PI);
  await mkdir(target, { recursive: true });
  await cp(join(root, PI), staged, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const counts = { moduleUrls: 0, stubs: 0, removed: 0 };
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(target, path).replace(/\\/g, "/");
      if (PI_WORKER_REMOVED.some(removed => name.endsWith(`node_modules/${removed}`))) {
        await rm(path, { recursive: true });
        counts.removed++;
        continue;
      }
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) continue;
      if (!/\.[cm]?js$/.test(entry.name)) continue;
      const stub = stubFor(name);
      if (stub) {
        const original = pathToFileURL(join(root, name)).href;
        await writeFile(path, stubSource(stub.path, await exportNames(original)));
        counts.stubs++;
        continue;
      }
      const source = await readFile(path, "utf8");
      if (!source.includes("import.meta.url")) continue;
      const result = await transform(source, { loader: "js", sourcefile: name,
        define: { "import.meta.url": JSON.stringify(pathToFileURL(`/bundle/${name}`).href) } });
      await writeFile(path, result.code);
      counts.moduleUrls++;
    }
  }
  await visit(staged);
  const resources = PI_RESOURCES.map(name => `${PI}/${name}`);
  await writeFile(join(target, "resources.mjs"), resources.map((path, index) =>
    `import r${index} from ${JSON.stringify(`./${path}`)};`).join("\n") +
    `\nexport const resourceBytes = [${resources.map((_, index) => `r${index}`).join(",")}].reduce((n, text) => n + text.length, 0);\n`);
  for (const [name, module] of Object.entries(entries)) {
    const specifier = JSON.stringify(module);
    await writeFile(join(target, `${name}.mjs`), `import { resourceBytes } from "./resources.mjs";\n` +
      `if (!resourceBytes) throw new Error("PI_RESOURCES_MISSING");\nexport { default } from ${specifier};\nexport * from ${specifier};\n`);
  }
  return { ...counts, resources: resources.length };
}

/**
 * Wrangler `alias` entries for a Worker bundling the staged Pi at `staged` (relative to the config,
 * e.g. "./.wrangler/pi"): Pi, its TypeBox validator settings, and pi-ai resolve to the one staged
 * copy, so a consumer's own pi-ai imports do not bundle a second pi-ai and OpenAI SDK.
 */
export function workerAliases(staged) {
  const pi = `${staged}/${PI}`;
  const ai = `${pi}/node_modules/@earendil-works/pi-ai/dist`;
  return {
    "@earendil-works/pi-coding-agent": `${pi}/dist/index.js`,
    "typebox/system": `${pi}/node_modules/typebox/build/system/index.mjs`,
    "@earendil-works/pi-ai": `${ai}/index.js`,
    "@earendil-works/pi-ai/api/openai-completions": `${ai}/api/openai-completions.js`,
  };
}

/** The Wrangler module rule that bundles Pi's resources as text. */
export const PI_TEXT_RULE = { type: "Text", globs: PI_RESOURCES.map(name => `**/pi-coding-agent/${name}`), fallthrough: false };
