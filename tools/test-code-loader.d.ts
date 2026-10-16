// Types of tools/test-code-loader.js (Node tests only; never product code).
import type { CodeLoader } from "../src/runtime/index.js";

export function testCodeLoader(options?: { onLoad?: (code: Parameters<CodeLoader["load"]>[0]) => void }): CodeLoader;
