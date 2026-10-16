// The browser layer's public surface. Types are in index.d.ts.
export { BrowserCoreError } from "./errors.js";
export { withTab } from "./cdp.js";
export { childFrameId, evaluateInFrame, frameDocumentObject, frameDocuments, MAX_FRAMES } from "./frames.js";
export { findClickables, MAX_CLICKABLES } from "./clickables.js";
export { boxCenter, hitTest, nodeClickPoint, obscuredMessage, settledHitTest } from "./pointer.js";
export { scrollPage } from "./scroll.js";
export { selectOptions } from "./select.js";
export { agentWindowId, createAgentTab, describeOpenedTabs, prepareInput, rememberedAgentWindowId, watchOpenedTabs } from "./tabs.js";
export { isPdfViewer, pdfViewerInputMessage, sameDocument } from "./pdf.js";
export { DESCRIBE_CLICKABLES, DISCOVER_CLICKABLES, HIT_TEST, hitsComposedTarget, observeScroll, SELECT_OPTIONS } from "./page-scripts.js";
export { CODE_LANGUAGES, CODE_RUN_LIMITS, CODE_SANDBOX_CSP, CODE_SANDBOX_PAGE, codeRunFailure, codeRunRequest } from "./code-run.js";
export { createCodeSandbox } from "./code-sandbox.js";
export { loadPinnedSource } from "./code-source.js";
export { runInWorker, serveCodeSandboxPage } from "./code-sandbox-page.js";
export { CODE_WORKER_BLOCKED_GLOBALS, serveCodeRun } from "./code-worker.js";
