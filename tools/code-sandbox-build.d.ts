// Types of tools/code-sandbox-build.js (build time only).
type Build = (options: Record<string, unknown>) => Promise<{ outputFiles: { text: string }[] }>;

/** The sandboxed page's script, its JavaScript Worker inlined as CODE_WORKER_SOURCE. */
export function buildCodeSandboxScript(options: { build: Build; pageEntry: string; workerEntry: string; root: string }): Promise<string>;

/** The shell Worker of bash runs and its content address `<pathPrefix>just-bash-<version>-<sha256>.js`. */
export function buildShellSandbox(options: { build: Build; entry: string; root: string; pathPrefix: string }): Promise<{ text: string; sha256: string; version: string; path: string; license: string }>;
