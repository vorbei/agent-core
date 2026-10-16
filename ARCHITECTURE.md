# Architecture

agent-core holds every capability that pi-do-browser-ext and X Gardener share. pi-do is this core
packaged as an app (configuration and composition only); X Gardener runs the same core and adds
X and connectors on top through the extension points below. A capability either
lives here and both run it, or it is product-specific and lives in that product.

```
src/
  browser/   the extension-side executor: CDP sessions, frames, clickables, pointer, scroll,
             select, agent tabs, PDF viewer; the code sandbox (model-written JavaScript or bash run
             in a sandboxed extension page's Worker)
  browser-tool/ the core browser tool's action model (actions, keys, argument rules, parameter
             schema), registered by a product's Worker and run by its executor
  guidance/  the model prose both products send for the same core behaviour (the planning rules,
             the answer-length rule, the pending-action steer, the output-limit notice, the tab
             context line), each product's tool names passed in
  memory/    what the agent remembers: long-term account memory (store, permission rule,
             confirmed instructions for the prompt, the model's memory tools), page guides,
             context compaction policy
  pi/        one durable attempt on a pi-coding-agent session (PiAttempt) and the branch journal
             it writes: session, reconciliation, row storage, format migration, thread restore
  routine/   Routines: a schedule (days, time, zone, start window) and its cron, the object's
             alarm as a durable job queue, the thread table Routines and their runs live in, a
             Routine firing into a run thread, its definitions and projections, over a RoutineHost
  runtime/   the conversation runtime: the durable turn budget, model failure codes and retry
             rule, final-answer checks, the durable turn queue (its SQLite schema, the
             scheduler, executor calls, tool receipts, recovery) driven through a TurnHost, the
             turn projection both chats read, the server-side PDF read, and sandboxed code
             execution (a Worker Loader isolate with no network)
  web/       the public web without a browser: one safe page read as readable evidence, a web
             search over a provider chain (OpenRouter, Tavily, Brave)
  ui/        the chat UI (React 19 + marked, JSX the product bundles): threads, turns, progress,
             composer, safe Markdown, over a ChatClient, with product parts in ChatSlots; the
             side panel's shell around it (header with the Chat control and the "…" menu,
             full-height layout); the Routine view (list and editor) over a RoutineClient
tools/       build and test time only (never bundled): the Worker build of Pi, its Node stub
             hooks, the Worker size check, a node:vm stand-in for the Worker Loader in unit tests
```

## How a consumer builds its Worker (tools)

Both Workers run Pi from one staged copy that `stagePi` (`agent-core/worker-bundle`) writes to
`<product>/.wrangler/pi` as the product's Wrangler build command: module URLs mapped to `/bundle`
paths, Pi's package resources attached to each entry, and the modules no Worker code path runs
(`PI_WORKER_STUBS`: Pi's CLI and terminal UI, highlight.js, jiti, undici, photon, yaml, pi-ai's
built-in APIs other than OpenAI completions) replaced by stubs that throw `PI_WORKER_STUB` on any
use. A Worker session has no file extensions, skills, prompt templates, themes or built-in tools
and streams through the host's provider, which is why these stay unreached. `workerAliases` and
`PI_TEXT_RULE` are the Wrangler `alias` and module rule (Pi, pi-ai and TypeBox's settings resolve
to the staged copy: one pi-ai, one OpenAI SDK).

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `stagePi({ root, transform, entries })` | `scripts/prepare-pi.ts`: the Worker entry | `tooling/worker/prepare-pi.mjs`: the Worker and the remote-agent acceptance Worker |
| `workerAliases`, `PI_TEXT_RULE` | `scripts/wrangler-config.ts` (generated `wrangler.jsonc`) | `wrangler.config.ts` and its acceptance Worker config |
| `tools/worker-size.js <dir> --max-gzip-kib <n>` | `npm run worker:size` in its `check` | `npm run worker:size` in `gate-local.sh` |

`--import agent-core/worker-stubs` (`tools/worker-stubs.js`) loads the same stubs in Node and fails
the process when any stub was used, even where the error was caught; this package's and
Gardener's `npm test` run that way, so a code path that reaches a stubbed module fails there before
it fails in a Worker.

## How a consumer plugs in (browser layer)

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `withTab(api, tabId, work, config)`: the CDP transport | its allowlist, timeouts | not used: Gardener keeps its own transport (dialogs, observers, cancellation, feedback overlays) and calls the layer's functions through a `send` adapter |
| `Send` (`send(method, params, sessionId)` + `iframeSessions()`) | from `withTab` | an adapter over its `sendCommand` |
| `AgentWindowConfig` | storage key, no tab group | storage key, the `𝕏` group and its legacy title |
| model-facing wording | refusal names its read action (`pdfViewerInputMessage("read_text")`) | `pdfViewerInputMessage("read")` |
| `findClickables(send, frame, { max, worldName })` → `{ clickables, discoveryError }` | the default bound, page world; a short snapshot note when `discoveryError` is set | `max: 300`; a selected iframe's discovery runs in Gardener's isolated world (`worldName`); a short snapshot note when `discoveryError` is set |
| `prepareInput(api, tab, send, sleep, { emulateFocus, settleMs })` → `{ visibility, focusEmulation }` | defaults; before each input action | inside its transport, once per attachment for focus emulation, `settleMs: 300`; a hidden page's input acknowledgement is not reported as verified |

### The core browser tool

`browser` is the core's browser tool: one action per call (`BROWSER_ACTIONS`: tabs, open,
select_tab, navigate, snapshot, click, type, select, press, scroll, read_text, screenshot) on a tab
named by its id, refs (e12) from that tab's latest snapshot. Its action model is defined once in
its own layer, `agent-core/browser-tool` (`src/browser-tool/tool.js`; apart from the executor, so
a Worker registers the tool without importing it and the code sandbox's pinned bundles do not
change with it): `parseBrowserCall` (throws `INVALID_ARGS`), `BROWSER_TOOL_PARAMETERS` (a
JSON schema), `PRESS_KEYS`, `ACTING_ACTIONS` (act on a page) and `READING_ACTIONS`; its description
is `agent-core/guidance` `BROWSER_TOOL_DESCRIPTION`. A product runs a validated call with its own
executor.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| the tool | `browser` in `src/worker/turns.ts`: the core's name, parameters and description; the call queued for its extension, whose executor (`src/browser/executor.ts`) runs it on its CDP transport; its wire (`src/shared/protocol.ts`) carries the core's call shape | `browser` beside `agent_browser` (`contract/browser-tool.js`): the core's name and parameters, the core's description followed by Gardener's lines (knowledge bundle); each call runs as the agent_browser argv it maps to, with the tab asserted as the Chat's selected tab, through agent_browser's guards, durable call, prepared actions and receipts. `agent_browser` keeps the other commands (batch, scripts, network waits, skills, X helpers) |

`boxCenter` refuses a zero-area box in both modes (border, and the content box refs use): the
point is never taken from a different box than the one asked for. `nodeClickPoint` waits at most
one frame or 50 ms after a scroll moved the target, and not at all on a hidden page.
`findClickables` creates its remote objects in one object group and releases it in one call
(consumers with a CDP allowlist allow `Runtime.releaseObjectGroup`).

### The code sandbox

Model-written code runs in the extension, never on a server: the extension page calls
`createCodeSandbox({ document, url })` and `run({ language, code, files, timeoutMs, maxOutputChars })`.
On the first run it embeds the sandboxed page (`CODE_SANDBOX_PAGE`, `agent-core/browser/code-sandbox.html`)
in a hidden iframe. That page (`serveCodeSandboxPage`) has an opaque origin (no extension API,
cookies or storage of the extension) and the manifest's `CODE_SANDBOX_CSP`: it may evaluate code and
start Workers from a blob, and `connect-src 'none'` refuses fetch, XHR, WebSocket and EventSource
(a blob Worker inherits the policy; its importScripts falls under `script-src`, the extension's own
files only). Each run gets a fresh Worker (`runInWorker`), terminated at the run's timeout, so a busy
loop ends as `EXEC_TIMEOUT` with the console lines it wrote; the client replaces a page that does not
answer within the timeout plus a grace. In the Worker, `serveCodeRun` first removes
`CODE_WORKER_BLOCKED_GLOBALS` (network, storage, nested Workers and channels, `chrome`, and the
Worker's own `postMessage`), then runs JavaScript as an async function body (`console` captured,
`files` an object) or a bash script in the product's `Bash` (just-bash's in-memory shell, `hardened`
limits, the run's deadline, no network option). `codeRunRequest` validates a request and clamps it
to `CODE_RUN_LIMITS`; only an invalid request throws (`CODE_REQUIRED`, `CODE_TOO_LARGE`,
`CODE_LANGUAGE_INVALID`, `CODE_FILES_INVALID`), every other failure is a result (`CODE_ERROR`,
`EXIT_STATUS`, `EXEC_TIMEOUT`, `SANDBOX_FAILED`, `SANDBOX_UNAVAILABLE`, `CODE_LANGUAGE_UNAVAILABLE`).
The core imports no shell: the product's Worker entry passes one. The shell Worker need not ship
with the extension: `createCodeSandbox`'s `shellSource` supplies its text on the first bash run (a
JavaScript run never asks), and the run message carries it to the sandboxed page, which starts the
run's Worker from it instead of its own. `loadPinnedSource({ sha256, url, fetch, caches })` is
that source for a script on the product's server: it returns the text only when its SHA-256 is the
pinned one (`SANDBOX_SOURCE_MISMATCH` otherwise, never cached; `SANDBOX_SOURCE_UNAVAILABLE` when it
cannot be had), fetched without credentials and kept in the page's Cache API under the hash, whose
entry is checked again on every read.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `createCodeSandbox({ document, url, shellSource })` | the side panel's document, `chrome.runtime.getURL(CODE_SANDBOX_PAGE)`; `shellSource`: `loadPinnedSource` of its Worker's `/sandbox/just-bash-<version>-<sha256>.js` with the hash its build pinned, the panel's `caches`; runs `run_code` calls the work loop claims, with `RUN_CODE_LIMITS` | the offscreen document (`src/ext/code/offscreen-code-host.js`; a service worker cannot embed the page), `chrome.runtime.getURL(CODE_SANDBOX_PAGE)`; `shellSource`: `loadPinnedSource` of the account's Worker origin + the path and hash in the extension's `code-shell.json` (written by its build); runs the `run_code` account function the service worker claims (`src/ext/code/run-code.js`), with the core's default limits. `js_exec` stays Worker-side on `runSandboxedCode`, only to compose Gardener's read tools |
| the sandboxed page's bundle (`code-sandbox.js` beside the page) | `src/ext/code-sandbox.ts`: `serveCodeSandboxPage(window, { workerSource })`, its own Worker (`src/ext/code-worker.ts`, `serveCodeRun(self)`: JavaScript only) bundled as text by `scripts/build-extension.ts` | `src/ext/code/code-sandbox-page.js` and `code-worker.js` (the same calls), built by its WXT hook (`wxt.config.js`) |
| the shell Worker's bundle | `src/ext/code-shell-worker.ts`: `serveCodeRun(self, { Bash })` with `Bash` from `just-bash/browser`, node built-ins stubbed (gzip fails as a command error); built by `scripts/build-sandbox.ts`, served by its Worker as a static asset, not shipped in the extension | `src/ext/code/code-shell-worker.js` with its own just-bash; built by `tooling/worker/code-sandbox-build.mjs` (the Worker's build command, assets in `.wrangler/assets`) and by the extension's build, which pins the same hash |
| `buildCodeSandboxScript`, `buildShellSandbox` (`agent-core/code-sandbox-build`, build time only): the two bundles from the product's entries with its esbuild | `scripts/build-extension.ts`, `scripts/build-sandbox.ts` | `tooling/worker/code-sandbox-build.mjs` (both its Worker build and its extension build) |
| `runCodeDescription({ timeoutSeconds })` (`agent-core/guidance`): the run_code tool's description | `src/worker/prompt.ts` | `contract/account-functions.js` |
| manifest | `sandbox.pages: [CODE_SANDBOX_PAGE]`, `content_security_policy.sandbox: CODE_SANDBOX_CSP`, written by its build | the same, declared in `src/ext/manifest.js` |

Codes thrown by the layer: `BROWSER_ATTACH_FAILED`, `BROWSER_CDP_TIMEOUT`, `BROWSER_DETACHED`,
`CDP_METHOD_BLOCKED`, `FRAME_GONE`, `TARGET_NOT_VISIBLE`, `TARGET_STALE`, `TARGET_NOT_SELECT`,
`OPTION_NOT_FOUND`, `PAGE_SCRIPT_FAILED`. Functions that find a problem the consumer words itself
(an occluded click) return it (`hitTest` → `HitResult`) instead of throwing.

## How a consumer plugs in (guidance layer)

A rule both products send the model is written once here, never copied into either product's
prose; a rule only one product sends stays in that product. The products differ only in where the
text is placed and in the tool names they pass.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `planRules({ compute })`: the planning rules, one `- ` line each | `RUN_CODE_TOOL`; placed under `## Plan` in `SYSTEM_PROMPT` (`src/worker/prompt.ts`) | `run_code` (the same tool as pi-do's); the knowledge build (`tooling/knowledge/build.mjs`) writes it in place of `{{CORE_PLAN_RULES}}` in `knowledge/system/system-prompt.md`, so the runtime reads it from the bundle |
| `ANSWER_LENGTH_RULE` | at the end of `## Answer` | in place of `{{CORE_ANSWER_LENGTH_RULE}}`, by the same build |
| `contextLine({ tabId, url, title } \| null)`: the `<browser_context>` line before a side-panel message's text | the tab the user picked (the current tab by default), its numeric `tabId`; `null` reads "no tab selected" | the Chat's bound tab (the first tab bound stays bound), `tabId` as `t<id>`; no line when no tab is bound or the client is older (`tab_context` on the turn request) |
| `PENDING_ACTION_STEER`, `OUTPUT_LIMIT_NOTICE`: the Pi layer's `pendingActionWording` and `outputLimitWording` | passed to `PiAttempt` by `src/worker/turns.ts` | the knowledge build writes them into the bundle's `runtime.pendingActionSteer` and `runtime.outputLimitRecovery`, which `src/pi/adapter.js` passes |

## How a consumer plugs in (web layer)

`agent-core/web` is the public web without a browser, for a product's Worker-side tools.
`fetchWebEvidence({ url, maxBytes }, { fetchImpl, resolveHostname, imagePreview })` reads one public
page: HTTP(S) only, no URL credentials, default ports, no private, local or metadata host (checked
again after DNS and on each of at most 5 redirects, which are followed by hand), a bounded body
(256 KiB of raw bytes) and a 20 s deadline that also covers a stalled body; the text is Mozilla
Readability's article over an inert linkedom DOM, else the page's semantic text (JSON
pretty-printed, plain text as it is), returned as untrusted `web-evidence-v1`. An image is evidence
only through the product's `imagePreview`. `searchWeb({ query, max_results, include_domains },
keys, { fetchImpl, onEvent })` tries OpenRouter's web search (one billed search per call; only its
annotations are sources), then Tavily, then Brave, each only with its key; the first with results
in the requested domains wins. Provider bodies and keys never reach an error or event; a billed
OpenRouter search reports its cost (`providerUsage[].costUsd`, also on the thrown error) so the
product can count it in the turn's spend. Codes: `WEB_FETCH_*` (`WebFetchError`),
`WEB_SEARCH_INPUT_INVALID`, `SEARCH_PROVIDER_UNCONFIGURED`, `SEARCH_PROVIDERS_FAILED` (with each
provider's `SEARCH_*` cause). The layer's peer dependencies are `@mozilla/readability` and
`linkedom`.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| tools | `web_search`, `web_fetch` (`src/worker/web-tools.ts`): TypeBox schemas and arguments in `src/shared/protocol.ts`, prose in `src/worker/prompt.ts`, results as text (sources; the page text cut at 20,000 characters) | `web_search`, `web_fetch` server tools: the zod contract (`contract/web-tools.js`), its result envelope and research projections |
| keys | `OPENROUTER_API_KEY` (required anyway), optional `TAVILY_API_KEY`, `BRAVE_API_KEY` secrets | the Worker's env, the same three names |
| `imagePreview` | none (an image URL is an unsupported type) | the Images binding (`src/cf/image-preview.js`) |
| a search's cost | `budget.addCost` of the turn (its `TURN_BUDGET.costUsd`) | `budget.addCost` of the turn (`AGENT_TURN_BUDGET.costUsd`), in `src/cf/account/pi-tools.js` |
| storage | none | the read evidence in its ResearchDO (`web_evidence`) |
| URL policy and bounded reads elsewhere | none | `validatePublicUrl`, `resolveSafeUrl`, `readBoundedText`/`Bytes` for its api tool, `agent_browser read <url>` and PDF reads |

## How a consumer plugs in (memory layer)

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `SqlStorage` (`sql.exec`, `transactionSync`) | its AccountDO storage; creates `MEMORY_SCHEMA` | its AccountDO storage; its own migrations already create the same `memories` table |
| `remember` input `sourceType` | `agent` from the model's tool | `agent` from the model's tool; `user_confirmed` only through the Memory page |
| browser-experience memories (`source_type = 'browser_experience'`) | not used | saved and searched by Gardener (`src/sqlite/cf/browser-experience.js`); `replacementReceipt` reports their scope |
| tool schemas and model-facing descriptions | TypeBox schemas, prose in `src/worker/prompt.ts` | zod contract (`contract/agent-tools.js`), prose there |
| the model's memory tools (`MEMORY_TOOL_NAMES`, `offeredMemoryTools`, `memoryToolPermission`, `runMemoryTool` over a `MemoryToolStore`) | Pi tools over `memoryStore(storage)`; the permission checked against the message's `update` flag; its own receipts and result shapes (`src/worker/memory-tools.ts`) | server tools through its audited layer (`src/cf/account/server-tools.js`); the permission checked against the Chat's permission snapshot (`pi-tools.js`); a store that routes browser experience to its own records |
| `GuideDomain[]` page guides | `PAGE_GUIDES` in `src/worker/prompt.ts` | the knowledge bundle (`knowledge/domains/`) |
| compaction thresholds and summarizer | thresholds in `src/config.ts`; its own summary prompt; a stored per-thread summary | Pi's native compaction driven by `piCompactionSettings`; its summary model and prompt |

| `forgetMemory(storage, id, { userInitiated })` | the agent's forget tool without the flag; the Memory view's delete with `userInitiated: true` | the same |

Codes thrown by the memory layer: `MEMORY_NOT_FOUND`, `MEMORY_INVALID`. A memory the user
confirmed is never replaced (`remember` with `supersedes`) or forgotten by the agent: both return a
receipt saying so (`replacement.applied: false`, `forgotten: false, reason: "user_confirmed"`).

## How a consumer plugs in (runtime layer)

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `createTurnBudget(saved, { maxModelCalls, maxToolCalls, modelSpendAvailable, maxCostUsd })`: a refused model request stops the turn as `MODEL_TURN_SPEND_LIMIT` (its own ceiling) or `MODEL_SPEND_LIMIT` (the cap outside it, named first) | `TURN_BUDGET` ceilings; `maxCostUsd` = its per-turn USD ceiling (the attempt adds each response's estimated cost, `addCost`) | `AGENT_TURN_BUDGET` ceilings (`src/pi/turn-budget.js`); `modelSpendAvailable` = the account's monthly cap; `maxCostUsd` = `AGENT_TURN_BUDGET.costUsd` ($0.50, every turn, vision included), counted from the cost OpenRouter reports for each response |
| `queueTurnRetry(host, turnId, key, { turnBudget, retryable, permissions, pendingWork })` | `TURN_BUDGET`'s model and tool calls; the turn's own permissions (`POST /api/turns/<id>/retry`) | `AGENT_TURN_BUDGET`; no retry of an MCP direct turn, the Chat's permissions while it is active, a reserved X action blocks it |
| `turnPage(host, { threadId, limit, before, columns })` | its turn list (`GET /api/threads/<id>/turns?before=`) | `listAgentTurns` |
| `modelFailureCode(error, { origin })`, `isRetryableModelFailure` | its retry loop in `turns.ts`; `origin: "other"` for errors not from the model request | `turns.js` retry scheduling (`origin: "other"` unless the error came from the model request), `adapter.js` |
| `stripToolMarkup` → `{ text, stripped }`, `lengthLimit`, `answerLength` | through the Pi layer's `answerRepairPolicy`: one tools-off plain-prose request for markup, one rewrite for an exceeded length limit | the same `answerRepairPolicy` after its X source review (`MODEL_ANSWER_REPAIR`, on; prose in `knowledge/runtime/answer-*.md`); markup is also stripped from the delivered answer, which keeps the original text when stripping would leave nothing |
| `readPdf(url, { fetch, toMarkdown, cache, validateUrl, limits, maxChars })` → `{ title, pages, from, firstPage, text }`, `PdfReadError` | `POST /api/pdf/text` (the extension's `read_text` of a PDF tab): its limits, loopback only with the smoke's converter, the account's conversion cache (`pdf_cache`) | the `agent_browser read` of a PDF URL (`src/cf/research/browser-pdf.js`): its public-URL rule, no cache |
| `runSandboxedCode({ loader, code, timeoutMs, maxOutputChars, tools })` → `{ ok, value \| error, logs, truncated, calls }` | not used: its `run_code` runs in the extension (the browser layer's code sandbox); `TURN_BUDGET.codeRuns` is still `createTurnBudget`'s `maxCodeExecCalls` | `js_exec` (`src/cf/code-exec.js`): `CODE_MODE_LOADER`, its read tools (`CODE_EXEC_TOOL_NAMES`) through `CodeModeToolsBinding` as `GARDENER`, the model's timeout and output cap; the `codeExec` ceiling `AGENT_TURN_BUDGET.codeRuns` (6), shared with `run_code`; the result mapped back to `{ ok, data, error, calls }` |

`runSandboxedCode` runs the code as the body of an async function in a fresh isolate: `env` holds
only the product's tool binding (nothing by default), `globalOutbound: null` makes fetch, connect
and WebSocket throw on the platform, `limits.cpuMs` is the timeout capped at `CODE_EXEC_LIMITS.cpuMs`
(5 s: a loaded isolate may run on its caller's thread, so a Durable Object that runs code answers
nothing else while it computes; enforced on a deployed Worker; `wrangler dev` does not enforce it,
so a tight loop hangs a local dev server), an in-isolate
timer and a host-side deadline bound waiting, and the value, error and console lines are capped.
Only invalid input throws (`CODE_MODE_UNAVAILABLE`, `CODE_REQUIRED`, `CODE_TOO_LARGE`); a throw, a
compile error, a timeout or a CPU stop is a result (`CODE_ERROR`, `EXEC_TIMEOUT`, `EXEC_CPU_LIMIT`).
`agent-core/test-code-loader` is a node:vm stand-in for unit tests only; it is no sandbox and no
product code imports it.

`stripToolMarkup` removes only closed tool-call blocks that are the whole answer or its trailing
part, each on its own line and outside a code fence; prose that mentions or shows such markup is
kept, and the rest of the text is returned unchanged. `modelFailureCode` reads a status only in
an HTTP/status form or a leading provider status (a bare "500 tokens" is not one), ignores a
success status, and reads nothing from the message of an error with `origin: "other"`.

## How a consumer plugs in (the durable turn queue)

Both products store turns in the core's tables (`RUNTIME_SCHEMA`: `agent_turns`,
`agent_turn_steps`, `agent_function_calls`, `agent_tool_receipts`, `idempotency_records`), with
the core's statuses and `input_json`/`checkpoint_json` keys, and drive them through a `TurnHost`
(`src/runtime/index.d.ts`).

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| schema | applies `RUNTIME_SCHEMA` | its own historical migrations build the same shape; `tests/runtime-schema.test.js` holds them equal |
| `startAttempt(turnId)` | the core driver, `runTurnAttempt` | `AccountDO.executeDurableAttempt` (the core driver, `runTurnAttempt`) |
| limits (`modelConcurrency`, `modelDeadlineMs`, `maxAttempts`, `executorClaimWaitMs`, `executorLeaseMs`) | `src/config.ts` (a 5-minute browser-call lease covers the user's confirmation) | `AGENT_MODEL_CONCURRENCY`, `MODEL_TIMEOUT_MS`, `AGENT_TURN_BUDGET.attempts`, `BROWSER_CLAIM_WAIT_MS`; the default call lease |
| `turnPriority(turn)` | none (all 0) | 1 for a Routine run's turn: Chat goes first |
| `claimScope({ installId, identity })` | none: the account token is the claim's authority | the connected install only; X functions only with the account's own X handle |
| `calls` (`readOnly`, `executor`, `settled`, `error`) | `readOnly`: the reading browser actions (`snapshot`, `read_text`, `tabs` ...), any other action is leased once and expires as `EFFECT_UNKNOWN`; its tool-error text | `readOnly`: server tools by their contract, a connector write is leased once and expires as `EFFECT_UNKNOWN`; `executor`: the account functions; `settled` and `error`: the result envelope (`replaceToolResult`, `piFunctionResult`) |
| `writeResult(call, turn, settlement)` | puts the result in its journal's waiting tool result | prepared X actions hold the call (`held`); else the result replaces the waiting tool result in the Pi checkpoint, with collection reads, connector settlement and domain-script receipts; a direct browser turn completes |
| `checkpointCodec`, `describeSettlement`, `external` (`recover`, `cancel`) | none, none, none; `notify` wakes a waiting browser claim | images archived to R2 (`encode`, `store`, `load`), its runtime log fields, action-ledger resumption and the rejection of a cancelled turn's prepared X actions |

`writeResult` stays the product's hook, but the journal write inside it is the core's: it calls
`writeJournalResult` (agent-core/pi), which hydrates the waiting turn's checkpoint, takes the new
model messages from the product and stores them as a branch of the journal. Codes:
`MODEL_TURN_LEASE_LOST` (thrown), `TURN_ATTEMPTS_EXHAUSTED`, `CHROME_OFFLINE`
(`EXECUTOR_OFFLINE`), `BROWSER_FUNCTION_TIMEOUT`, `EFFECT_UNKNOWN` (stored on rows), and the
messages `FUNCTION_CALL_LEASE_INVALID`, `FUNCTION_RESULT_CONFLICT`, `FUNCTION_CALL_TURN_INVALID`.
Tool receipts answer `TOOL_CALL_ID_CONFLICT`, `TOOL_EXECUTION_INTERRUPTED`, `TOOL_NOT_STARTED`.

Steers are queued turn rows (`whileRunning: "steer"`): the running attempt takes one at Pi's step
boundaries (`takeSteer`, marking it `placingLease`, with the product's rule over the row), and the
journal commit that carries it merges it (`mergeSteer`, `mergedIntoTurnId`); `releaseSteers`
frees the marks of a lost attempt.

## How a consumer plugs in (Pi layer)

`PiAttempt` (`src/pi/attempt.js`) runs one attempt of a turn on a `pi-coding-agent` session: the
turn budget reserved at Pi's boundaries, journal checkpoints at message ends (`onCheckpoint`) and
budget-only writes (`onBudget`), steers placed at `agent_start`/`turn_end` and merged with the
entry that carries them, threshold and background compaction through Pi's own cut (two pinned Pi
privates, `src/pi/pi-private.js`), tool-call markup stripped from the delivered answer, the
announced-action steer. A tool batch whose results include a call waiting for its executor
(`executorWaitingResult`, recognized by `awaitsExecutor`) ends the run there: neither the
last-step notice nor a queued steer is sent into Pi then, so no model request is spent on an
answer that the driver would cut as premature; the steer joins the resumed run. The journal is Pi's SessionManager journal, stored by
`checkpointForStorage` as `pi_journal_entries` rows plus a checkpoint header (format 2; format 1,
inline, and session context v1-v3 are compatibility branches). The persisted names
(`JOURNAL_ENTRY_TYPES`, checkpoint and journal versions) are data and never change without a
journal migration.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `streamFn`, `systemPrompt`, `tools`, `maxSteps`, `maxToolCalls`, `budget` | OpenRouter stream (tools off for its last tool step), its prompt, `browser` + memory tools, `TURN_BUDGET` | its model transport, prompt and tool bundles, `AGENT_TURN_BUDGET` |
| `onCheckpoint`, `onBudget`, `nextSteer` | its checkpoint and lease writes; steers with the same memory permission | its checkpoint (images archived) and lease writes; steers no more authorized than the turn |
| `contextView`, `compactionView` | its observation stubs; none | historical browser evidence, skill dedupe, observation stubs, snapshot deltas; skill dedupe |
| `contextTail` | none (the budget line) | knowledge card, page guide, budget line, execution references |
| `summarizeContext` | its summary request | its summary model |
| `task` (`progress`, `retainEvidence`, `finalizeAnswer`) | none | task progress (`task_checkpoint`); artifact links, read receipts, sources and read evidence kept past a compaction; artifact links kept exact in the answer |
| `outputPolicy`, `pendingActionWording`, `plugins` | plain-prose and length-limit checks; `PENDING_ACTION_STEER` (`agent-core/guidance`); none | X source review, then the plain-prose and length-limit checks; the same `PENDING_ACTION_STEER`, through the knowledge bundle; research and thread notes |
| `outputLimitWording` (the output recovery's notice) | `OUTPUT_LIMIT_NOTICE` (`agent-core/guidance`) | the same `OUTPUT_LIMIT_NOTICE`, which the knowledge build writes into the bundle's `runtime.outputLimitRecovery` |
| `writeJournalResult` in `writeResult` | the browser result (page guide added) replaces its waiting result | collection reads, the result envelope, task-progress enrichment |

## How a consumer plugs in (the turn driver)

`runTurnAttempt(host, turnId)` (`src/pi/turns.js`) is a host's `startAttempt`: it claims the turn,
releases steer marks a lost attempt left, restores the journal (or the thread's prior conversation,
`restorePriorMessages`), answers the calls of a lost attempt (`recoverToolMessages`: an executor
call's waiting or settled result, a completed receipt, an interrupted read replayed, an
interruption result), runs the `PiAttempt`, and then parks the turn on its executor calls (an
answer past a waiting call is cut at the last waiting result), completes it, or fails it (one
retry of a retryable model failure after a backoff, routed by the host; a response cut at its
output cap with no answer and no tool call is MODEL_OUTPUT_LIMIT, and its retry is the output
recovery: that attempt's requests go without tools, with twice `model.maxTokens`, Pi's
`reasoning: "low"` and the product's `outputLimitWording`). `cancelTurn` ends a turn,
the turns it owns (not a `background` child) and their open calls, and refuses a steer that is
already being placed (`already_delivering`); the journal keeps the waiting results and a restore
reads the settled call rows instead. The host is a `TurnDriverHost`: a `TurnHost` plus `attempt`.
While the model streams a message the driver stores the answer so far in
`agent_turns.partial_text` (under the attempt's lease, at most once per `PARTIAL_TEXT_INTERVAL_MS`
= 400 ms and only when it changed, its newest `PARTIAL_TEXT_MAX_CHARS` = 4,000 characters), calls
`notify(["ui"])` after each write, and clears it at the message's end and when the attempt ends.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `attempt.prepare(context)` → budget, tools, preface, text, `images`, `acceptsSteer`, `open` | `src/worker/turns.ts`: `TURN_BUDGET` with its spend (OpenRouter's reported cost, else its per-model price), the `browser` tool (its waiting result is `executorWaitingResult`) and memory tools under receipts, the core's `contextLine` (the tab the user picked) before the prompt and a steer's text, the message's attached images (its `turn_images`) as Pi image content, steers with the same memory permission, its prompt, the tools-off last step, `answerRepairPolicy` with its wording, `streamedSummary` with its prose; `reportModelRequests` around its stream, and `withModelDeadline` (per-model timeout) inside it | `src/cf/account/turn-attempt.js`: the turn budget (crystallization ceiling, monthly spend cap), the durable tools, the Write authorization preface, the core's `contextLine` naming the Chat's bound tab (as `tID`) before a side-panel message's text and a steer's, a message's `images` loaded from R2 (a promise; the driver awaits it), steers no more authorized than the turn (a steer with images only into a turn on its vision model), `GardenerPiAdapter` and its options |
| `attempt.direct(turn)` | none | an MCP `browserArgs` turn: the call is made without the model |
| `attempt.retryRouting`, `attempt.afterCompleted` | none | provider routing that skips the failed provider; crystallization and page-guide learning |

## How a consumer plugs in (turn projection)

`projectTurn(row, { fields, progress, errorCode })` (`src/runtime/projection.js`) is what both
products' APIs return for a turn row and both chats read: the base fields from the core's
`agent_turns` columns, the product's own fields after the identity, and the progress list built by
`turnProgress(items, status, labels)` from the product's activity items. `validateTurnProjection`
checks the base fields (and the list item's `input`, `parentTurnId`) and accepts the product's
named fields, which the product checks itself. `canStopTurn`, `canRetryTurn` and
`isActiveTurnStatus` are the turn controls the UI and the products share. A running row's
`partial_text` is projected as `partialText` (absent in every other case), which the chat renders
as the answer so far.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `fields` | `mergedIntoTurnId` | `executionMode`, `promptOverridden`, `mergedIntoTurnId`, `toolResult`, `delivery`, evidence and action results (in that order; its API bytes are unchanged) |
| activity items | `agent_turn_steps` joined with the browser calls (`src/worker/turns.ts`) | `runtime_events` and the calls (`contract/turn-activity.js`) |
| progress labels | English | its Chinese labels |
| list items | `input`, `parentTurnId: null` | `input` (null for an internal turn), `parentTurnId` |
| `partial_text` in the row | always (`SELECT *`) | only for a list read with `includePartial=true` (its 0.4a clients refuse unknown fields) |
| a message's images | `images` on every view | `images` only for a list read with `includeImages=true`, for the same reason |
| validator | its own fields named | `contract/agent-turn.js` re-exports the core's and adds its checks (evidence, delivery, error-code set) |

## How a consumer plugs in (chat UI)

`mountChat(element, { client, slots, menu, pageSize })` (`src/ui/index.jsx`) renders the chat of the
account set with `setAccount` and returns the handle a product's shell drives (`render`, `focus`,
`compose`, `openThread`). The chat restores the selected thread, follows its newest page on every
change the client reports and loads older pages on request, sends a message (a steer while a turn
runs), edits, stops, retries, and creates, selects and deletes threads in the thread menu. Its
styles are `ui/chat.css` (`chat-*` classes, `--chat-*` tokens); the product loads it before its
own CSS. One component set serves every width. The tokens are one palette in the look of Chrome's
own side panels (Material 3, light and dark): text, surfaces, lines, the primary color and its
container, success, warning and danger, the menu elevation and the font; every panel built on the
core (the shell, the Routine view, each product's own views) reads them, so pi-do and Gardener look
alike. A thread row in the thread menu shows its latest turn's state (`wording.threadStatus`) and
time, in the group the product names (`threadGroup`).

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `ChatClient` (`listThreads`, `createThread`, `deleteThread?`, `listTurns`, `submitTurn`, `stopTurn`, `retryTurn`, `subscribe`, `loadSelectedThread?`, `saveSelectedThread?`) | its Worker API over `fetch`; threads from its turns (`GET /api/threads`), a new thread is only an id until its first message, delete archives it (`DELETE /api/threads/<id>`, Gardener's convention); `subscribe` polls (every second while a turn is active, once a minute idle) | messages to its service worker; `subscribe` is the account-event relay with its backoff and 60 s fallback (`account-updates.js`) |
| `listed` | none (all) | Chats and Routine runs, not a Routine |
| `threadLabel` | none (the thread's title) | a run: its Routine's name and a pill with what started it |
| `threadGroup` | none (one group, Chats) | a run is listed under Routines, after the Chats |
| `threadView` | none | a Routine is read-only with a banner and a notice; a run has its banner, an empty-run notice and "Stop this run" |
| `welcome` | none (the wording's line) | its prompts |
| `tray` | the confirmation card (Allow once / Decline) | the pending X and browser action tray with approval |
| `controls` | the tab picker (the tab the message is about: current, one of the window's tabs, or none) | the recording control |
| `settings` | none (its Memory updates switch is in its Settings view) | the chat's permissions, the recording start, the browser preferences |
| `userInput`, `markdown` | none | the recording-analysis input; generated media only, links relative to x.com |
| `images` (paste and drop on the composer; `submitTurn` gets `images`, a turn's `images` show in its bubble) | its protocol's limits (4 images, 1568 px, 700,000 base64 characters each); its client loads a listed turn's images as object URLs | the same limits (`contract/agent-turn-input.js`); its client lists turns with `includeImages` and reads each image through its service worker as a `data:` URL |
| `wording` | its assistant name, placeholder, welcome | its assistant name and strings, failure messages from its turn-activity contract |
| `menu` | the panel header's Chat control | the panel header's Chat control |

## How a consumer plugs in (panel shell)

The side panel around the chat is the core's too (`src/ui/panel-shell.js`, styles `ui/panel.css`,
loaded after `chat.css`): `panelHeaderMarkup` builds the header (the Chat control that opens the
thread list, the "…" menu with one entry per product view), `bindPanelHeader` wires it (a view
control calls `onView`; one header menu open at a time, closed outside or on Escape),
`markPanelView` marks the shown view. The Chat control is a pill naming the open chat (the chat
fills its `[data-chat-title]`) while the chat is shown, and reads "Chat" otherwise; the shell also
draws the switch every settings row uses (a checkbox followed by an `<i>`). Anything that opens
over a view (the Routine editor, Gardener's Minify pages and secret form) is a page
(`agent-core/ui/page`: `pageHeadMarkup`, `focusPageTitle`, styles `.chat-page*`): it covers the
view with no backdrop under a back button, the view's name and its title; its opener focuses the
title and returns focus on back or Escape. Small confirmations stay inline. The panel
(`.chat-panel`) is the header row over
`.chat-panel-main`, whose `.chat-panel-view`s fill the rest, so the chat's messages scroll inside
it and its composer stays at the bottom. It is plain DOM markup, so an HTML-string shell and a React
one both use it. A product shows and hides its views itself.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `lead` | none: the Chat control leads, its status (`Ready`, `Working`, the browser action) after it | its account header (avatar, handle, cache and heartbeat indicators) |
| `more.items`, `extra`, `note` | Settings; its name and version | Routine, Logs, Memory, Connect, Minify; Setup guide; its name and version |
| base type | the shell's (system font, controls inherit it) | its own panel rules (`#x-gardener-panel`), which take precedence; FilterX uses the header and layout without the chat |

## How a consumer plugs in (Routines)

A Routine is a thread that carries a schedule and a prompt; each fire (its alarm, a retry, a run
started by hand) opens at most one run thread, an ordinary chat whose first turn is the prompt,
keyed by the fire so a replay reuses it. The tables are `THREADS_SCHEMA` (`agent_threads`) and
`ALARM_JOBS_SCHEMA` (`alarm_jobs`), adopted unchanged from Gardener (its
`tests/runtime-schema.test.js` holds them equal). The engine (`src/routine/fire.js`,
`routines.js`) is driven through a `RoutineHost` (`src/routine/index.d.ts`); the alarm queue
through an `AlarmHost`.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| schema | applies `THREADS_SCHEMA` and `ALARM_JOBS_SCHEMA`; adds `THREAD_COLUMNS` to its older `agent_threads` | its own historical migrations build the same shape |
| `AlarmHost` (`callbacks`, `invoke`, `recover`, `log`, `nextDeadline`) | `runRoutineAlarm` only; its turn recovery runs on every wake, and `nextDeadline` keeps the recovery cadence while a turn is open | `runRoutineAlarm`, `recoverAgentTurns`, `expireSyncTasks` (DO methods); its lifecycle log; the write queue on the DO (`alarmWrite`) |
| `account()` | its one account, always active | the account row; `active` unless paused |
| `jobs` | the core's alarm queue (`addAlarmJob`, `alarmJobs`, `cancelAlarmJob`) | its DO's `schedule`, `listSchedules`, `cancelSchedule` over the same queue |
| `ledger`, `log` | its structured log (no ledger) | `ledger_events` and its lifecycle log |
| `idempotent` | `idempotency_records` (`tool:<name>` rows) | its audited `idempotentTool` (also writes `tool_invocations`) |
| `runs` (`prepare`, `queue`, `finish`, `busy`) | a turn whose input is the prompt, no tab context, the run's memory permission and `readOnly` unless the run may act; busy = an unfinished turn in a run thread | `prepareDurableAgentTurn`, `insertQueuedTurn`, `finishQueuedTurn`; busy also counts an X sync or action continuation |
| `view` | its `RoutineThreadView` (`src/shared/protocol.ts`) | `publicAgentThread` (the contract's thread projection) |
| `defaultPermissions` | `{ update: false, write: false }` (read-only) | `{ update: false, write: true }` |
| `lastSeen`, `browserLive` | none: never idle-paused; a skipped run is not retried | the X connection heartbeat: a Routine pauses after 7 idle days; a run whose sync no browser picked up retries once |

## How a consumer plugs in (Routine view)

`createRoutineView({ element, client, slots, onClose, onOpenThread })` (`src/ui/routines.js`,
exported as `agent-core/ui/routines`, types in `routines.d.ts`, styles `ui/routines.css` loaded
after `panel.css`) renders the account's Routines as a list and one editor page over it (a
`agent-core/ui/page` page: back to the list, its name, Delete and Save; no backdrop): name,
instructions, the schedule (days and time, or the cron they make, and a random start window), the
permission switches, the run history with Run now. A manual run starts from a panel whose switches
are off until the user turns one on; a run opens as its conversation through `onOpenThread`. It is
plain DOM markup, like the panel shell.

| Extension point | pi-do passes | X Gardener passes |
| --- | --- | --- |
| `RoutineClient` (`list`, `get`, `save`, `remove`, `removeRun`, `run`, `subscribe`) | its Worker's `/api/routines` endpoints over `fetch`; `subscribe` polls | its service worker's `gardener:*-routine` messages; `subscribe` is the account-event relay |
| `title(thread)` | the default (title, else the prompt's first line) | `routineTitle` (the default Routine is named by its prompt) |
| `permissions`, `defaultPermissions` | Act in the browser (each committing action still asks), Update memory; read-only | Act on X, Update memory and settings; `{ write: true }` |
| `runNote`, `runLabel` | what the run may do in the browser | the X account the run acts as (`Run as @handle`) |
| `runLine(run)` | the default (the run's summary) | the summary unless it is the delivery notice |
| `instructionsHint`, `emptyList`, `deleteNote` | its wording | its wording (X actions) |
| `headerActions` | none | the pause between X actions beside "+" |

## What stays per product, and why

Every piece the two products run alike lives in this core (agent-core plan steps 0-7). What stays
in a product is either product (prose, schemas, shells, its edge) or a difference that is more
than a parameter:

- **Turn submission and the thread list.** Validation, thread linkage and replay keys are each
  product's request handling around the core's `insertTurn`. Both keep their threads in the core's
  `agent_threads`; Gardener also keeps per-Chat permissions, instructions and models there, while
  pi-do lists its threads from their turns (deletion archives, as in Gardener).
- **Observation stubs.** pi-do shortens all but its last four browser results and keeps one
  screenshot; Gardener stubs only superseded `agent_browser` and `browser` observations of the same document
  before the latest user message (the provider prefix-cache rule) and keeps the snapshots its
  deltas are taken against. The two differ in algorithm, not in parameters.
- **Thread notes and history** (Gardener's `src/pi/extensions/memory/`), the tool result envelope
  and its projections (`function-result-projection.js`, `tool-result-projection.js`) and task
  progress: Gardener's, plugged in through the attempt's options; pi-do has none of them.
- **The memory tools' schemas, prose and result shapes** (TypeBox and `prompt.ts` in pi-do, the
  zod contract in Gardener) and Gardener's browser-experience memories; the envelope is shared.
- **The PDF conversion cache.** pi-do's account table; Gardener reads without one (a cache would
  be a new table).
- **The side panels' views other than the chat and the Routine editor** (Gardener's
  Connect, Memory, Minify; pi-do's Settings) and what a product puts in the shared header, the Worker edge and transport, the model transport, and every word the
  model reads (Gardener's `knowledge/`, pi-do's `prompt.ts`) except the rules both send
  (`guidance/`).

What already keeps the two from drifting further: Gardener's `tests/source-boundaries.test.js`
fails when Gardener defines its own copy of any function this core exports, and both products
import this one package (the monorepo's `packages/agent-core`), so there is no copy to drift.
