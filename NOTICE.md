# Notice

agent-core is MIT-licensed (`LICENSE`). Its code was extracted from two projects by the same
author, X Gardener (branch `gardener-0.5`, commit `aabdb52`) and pi-do-browser-ext (`v0.1.3`,
commit `b1097ab`), and relicensed here under MIT by that author.

## Browser layer (`src/browser/`)

| File | From | Notes |
| --- | --- | --- |
| `cdp.js` | pi-do `src/browser/cdp.ts`, itself from Gardener `src/browser/cdp.js` | Per-tab queue, timeouts, idle detach, OOPIF flattened sessions with nested auto-attach; the method allowlist is the consumer's |
| `frames.js` | pi-do `src/browser/frames.ts`; Gardener `src/browser/agent/snapshot-input.js` | Frame documents with their sessions; `frameDocumentObject` is new (main-world documents of iframes) |
| `clickables.js`, `DISCOVER_CLICKABLES`, `DESCRIBE_CLICKABLES` | agent-browser cursor script as vendored by Gardener (`src/browser/vendor/agent-browser/snapshot-cursor.js`) and ported by pi-do | Runs in each frame's own world; does not mark the DOM; bounded |
| `pointer.js`, `HIT_TEST`, `hitsComposedTarget` | Gardener `src/browser/controls.js` (hit test before a click), `src/browser/frame.js`, `src/browser/value.js` (`boxModelCenter`) | Auto-detects an embedding chain the page cannot read |
| `scroll.js`, `observeScroll` | Gardener `src/browser/agent/scroll.js`; pi-do's wheel fallback | |
| `select.js`, `SELECT_OPTIONS` | agent-browser `SELECT_OPTIONS` as vendored by Gardener; pi-do's `input` event | |
| `tabs.js` | Gardener `src/browser/agent-window.js` (window adoption, tab group); pi-do `src/browser/tabs.ts` (`prepareInput`, `watchOpenedTabs`), from Gardener `input-focus.js` and `agent/popup-wait.js` | Group title and storage key are the consumer's |
| `pdf.js` | Gardener `src/browser/agent/content.js`, `agent/navigation-command.js`; pi-do executor | |
| `../browser-tool/tool.js` | pi-do `src/shared/protocol.ts` (the browser tool's actions, keys, argument rules), `src/worker/turns.ts` (its parameters) | The parameter schema is plain JSON Schema, byte-identical to pi-do's TypeBox output; `parseBrowserCall` throws an Error with `code` instead of pi-do's ProtocolError |

The agent-browser pieces come from [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)
v0.37.0 (`cli/src/native/snapshot.rs`, `cli/src/native/interaction.rs`), Apache-2.0; the license
is in `src/browser/LICENSE-agent-browser` and each change is noted where the code is.

## Guidance layer (`src/guidance/`)

| File | From | Notes |
| --- | --- | --- |
| `rules.js` | pi-do `src/worker/prompt.ts` (`## Plan`, the length-limit line, the pending-action steer, the output-limit notice, the tab context line, the browser and run_code tool descriptions) and Gardener `knowledge/system/system-prompt.md`, `knowledge/runtime/*.md` (the same rules and notices, and the check of rejected input against its source) | The code tool's name and the run timeout are the product's |

## Web layer (`src/web/`)

| File | From | Notes |
| --- | --- | --- |
| `fetch.js` | Gardener `src/cf/research/web-fetch.js` | Unchanged policy and bounds; ids and hashes from the runtime layer's stamps |
| `readable.js` | Gardener `src/cf/research/article-text.js` | Mozilla Readability (Apache-2.0) and linkedom (ISC) are peer dependencies, not copied |
| `search.js` | Gardener `src/cf/research/deep-search.ts` and `openrouter-search.ts`; the provider chain's rule from pi-deep-research 0.3.1 (`src/chain.ts`, MIT) | zod schemas replaced by plain checks; the chain is reimplemented here (skip unconfigured, first non-empty in-domain result wins), no package import |

## Memory layer (`src/memory/`)

| File | From | Notes |
| --- | --- | --- |
| `store.js` | Gardener `src/sqlite/cf/memory.js`, `src/cf/account/memory-view.js`, `contract/agent-tools.js` (`rememberPermission`), `contract/defaults.js` (`MEMORY_INSTRUCTION_MAX`), the `memories` DDL of `src/sqlite/cf/cf-schema.js` | Takes the storage as a parameter; browser experience stays in Gardener |
| `tools.js` | pi-do `src/worker/memory-tools.ts` (which tools a permission offers, the agent-sourced save, the forget without `userInitiated`) and Gardener `src/cf/account/pi-tools.js` (the per-call permission, `sourceType: "agent"`) (step 6) | The envelope only: schemas, descriptions, receipts, result shapes and Gardener's browser-experience routing (`MemoryToolStore`) are the product's |
| `page-guides.js` | Gardener `src/pi/knowledge/cards.js` (`pathCovers`, `bundledPageGuide`) | The guide list is passed in |
| `compaction.js` | Gardener `src/pi/context-compaction.js` | Gardener keeps its compacted-evidence message type and skill deduplication |

## Runtime layer (`src/runtime/`)

| File | From | Notes |
| --- | --- | --- |
| `turn-budget.js` | Gardener `src/pi/turn-budget.js` | Ceilings passed in; an `answerRepair` kind added for pi-do's final-answer rewrite |
| `model-failures.js` | Gardener `src/pi/turn-runtime.js`; pi-do `src/worker/model.ts` | Gardener's rules, plus pi-do's reading of an HTTP status, a provider's context-length error and "timeout" from the message |
| `answer-checks.js` | pi-do `src/worker/answer.ts` | Tool-call markup written as text; explicit length limits |
| `schema.js` | Gardener `src/sqlite/cf/cf-schema.js` and migrations 1-15 of `cf-migrations.js` (`agent_turns`, `agent_turn_steps`, `agent_function_calls`, `agent_tool_receipts`, `idempotency_records`, the turn projection triggers) | The shape Gardener's migrations produce, unchanged; Gardener's `tests/runtime-schema.test.js` holds the two equal |
| `turn-scheduler.js`, `turn-recovery.js` | Gardener `src/cf/account/turn-scheduler.js` (monorepo commit after `af6e979`) | Chat-before-Routine became the `turnPriority` hook, action-ledger recovery `external.recover`, the connector write rule `calls.readOnly` |
| `turn-steps.js` | Gardener `src/cf/account/turns.js` (`appendAgentTurnStep`) | |
| `function-calls.js` | Gardener `src/cf/account/function-calls.js` | X handle and install checks became `claimScope`; the checkpoint write, prepared X actions, collection reads and connector settlement stay in Gardener behind `writeResult` |
| `tool-receipts.js`, `stamps.js` | Gardener `src/cf/account/tool-execution.js`, `src/sqlite/cf/tool-receipts.js`, `src/cf/ids.js` | The model-facing error wording is the host's (`calls.error`) |
| `steers.js` | Gardener `src/cf/account/turns.js` (steer marks: take, merge, release) | The SQL filter of which steer a turn takes became the product's `accepts` rule (`unset` reads a JSON flag as SQLite did) |
| `turn-retry.js` | Gardener `src/cf/account/turn-retry.js` (step 4) | The direct-turn refusal, the Chat's permissions and status, and the reserved-action check became `retryable`, `permissions` and `pendingWork` |
| `turn-page.js` | Gardener `src/cf/account/turns.js` (`listAgentTurns` paging, step 4) | The projection of each row stays the product's |
| `turn-budget.js` `maxCostUsd`, `addCost` | pi-do `src/worker/budget.ts` (step 4) | A turn's own spend ceiling; absent, the state carries no cost (Gardener) |
| `projection.js` | Gardener `src/cf/account/turns.js` (`projectAgentTurn`), `contract/agent-turn.js` (validator, turn controls), `contract/turn-activity.js` (the progress label) (step 5) | The base fields; Gardener's fields (delivery, evidence, action results, direct tool results) and its error-code set stay in its contract, which re-exports these |
| `pdf-read.js` | pi-do `src/worker/pdf.ts` (fetch, caps, conversion, pages, cache interface) and Gardener `src/reads/sources/papers.js` `pdfPages` (the title, the first page shown) (step 6) | Errors are `PdfReadError` codes with pi-do's reasons as messages; the URL rule (`validateUrl`), limits, converter and cache are the product's; Reads keeps its own article conversion (`pdfBody`) |
| `code-exec.js` | Gardener `src/cf/code-exec.js` (`runRestrictedCode`, `buildRestrictedWorkerModule`; js_exec) | The nested tools and their binding name became the product's `tools` (none by default); the result is structured (`value` or `error`, `logs`, `truncated`) instead of thrown; a CPU limit and a host-side deadline were added; Gardener keeps its tool names and maps the result back to js_exec's shape |

## Pi layer (`src/pi/`)

| File | From | Notes |
| --- | --- | --- |
| `session.js`, `journal.js`, `pi-private.js` | Gardener `src/pi/session.js`, `src/pi/journal.js`, `src/pi/pi-private.js` (monorepo commit after `dfe4a9d`) | Unchanged but for temp-directory prefixes; the background-compaction context refresh moved from the adapter into `pi-private.js` |
| `attempt.js` | Gardener `src/pi/adapter.js` (`GardenerPiAdapter`) | Gardener's model view, knowledge tail, task progress, compaction evidence, artifact links and thread notes became options (`contextView`, `contextTail`, `progress`, `retainEvidence`, `finalizeAnswer`, `plugins`); Gardener's adapter is now a subclass |
| `harness.js`, `compaction.js`, `pending-action.js` | Gardener `src/pi/extensions/harness.js`, `extensions/compaction.js`, `extensions/pending-action.js` | The pending-action steer's wording is passed in |
| `journal-store.js`, `journal-migration.js` | Gardener `src/cf/account/journal-store.js`, `journal-migration.js` | Take the storage as a parameter; image references (`encode`) and the apply switch are the product's; `writeJournalResult` is the journal write of Gardener's `writeResult` |
| `session-context.js` | Gardener `src/pi/session-context.js` (`restoreSessionMessages`) | Gardener keeps the historical browser-evidence projection and output-review draft removal |
| `entry-types.js` | Gardener's persisted literals (`gardener_turn_authorization`, `gardener_resume`, `gardener_compacted_evidence`, checkpoint and journal versions) | Kept verbatim: they are stored data |
| `turns.js` | Gardener `src/cf/account/turns.js` (`executeDurableAttempt`, `cancelAgentTurn`, `restorePriorThreadMessages`, the queued-turn insert) and `turn-recovery.js` (monorepo commit after `a53aa8d`) | The model, prompt, tools, Pi options, direct browser turns, provider routing and learning became `attempt` hooks; the X action rejection on cancel `external.cancel`; images `checkpointCodec`; account-function names, server-tool read rules and the result envelope `calls`; the waiting-result text is Gardener's, verbatim (it is stored data); Gardener keeps submission and the projection |
| `answer-repair.js`, `summary-request.js`, `model-requests.js` | pi-do `src/worker/turns.ts` (`answerCheck`, `tracked`) and `src/worker/compaction.ts` (step 4) | The repair and summary prose is the product's; X Gardener does not use them yet |
| `model-deadline.js` | pi-do `src/worker/model.ts` (its per-request `AbortSignal.timeout`) | A cut request is reported as MODEL_TIMEOUT instead of Pi's abort; X Gardener's transport keeps its own deadline |

## Routine layer (`src/routine/`)

| File | From | Notes |
| --- | --- | --- |
| `schedule.js` | Gardener `src/cf/routine/schedule.js` (`nextRoutineTime`), `contract/agent-thread.js` (schedule, prompt and permission validation), `contract/routine.js` (`manualRunPermissions`), `src/ext/sidepanel/routine-text.js` (cron), `src/cf/routine/fire.js` (jitter, slot matching) | Gardener's contract re-exports them |
| `alarms.js` | Gardener `src/cf/alarms.js`, `src/sqlite/cf/alarm-jobs.js` | The callback names, the turn recovery and the log are the host's; the Agents SDK import stays Gardener's |
| `store.js` | Gardener `src/sqlite/cf/agent-threads.js` (thread reads with the newest turn, Routine and run rows, archival), the `agent_threads` DDL of `cf-schema.js` and its migrations | A run's busy check is the host's (Gardener's counts X continuations) |
| `fire.js`, `routines.js` | Gardener `src/cf/routine/fire.js`, `definitions.js` | Simplified first (one-time runs, the Routine model and instruction, the idle sweep and the schedule route removed); the account, jobs, ledger, idempotency, turn submission, projection and the X heartbeat became the `RoutineHost` |

## Chat UI (`src/ui/`)

| File | From | Notes |
| --- | --- | --- |
| `chat-host.jsx`, `turn.jsx`, `thread-menu.jsx`, `composer.jsx`, `markdown.jsx` | Gardener `src/ext/sidepanel/chat/index.jsx` (step 5) | The transport became `ChatClient`; the pending-action tray, Routine banners and read-only Routine threads, permissions, recording, generated media and the product's wording became `ChatSlots` (Gardener `chat/x-slots.jsx`); class names `gardener-*` became `chat-*` |
| `composer-settings.jsx`, `markdown.js`, `turn-groups.js` | Gardener `chat/composer-settings.jsx`, `chat/markdown.js`, `chat/turn-groups.js` | Unchanged but for class names |
| `chat.css` | Gardener `src/ext/sidepanel/panel.css` (its chat rules) | Colors and sizes are `--chat-*` tokens with Gardener's palette as the default; Gardener maps them to its own |
| `wording.js`, `config.js` | Gardener chat strings | The defaults with the product name taken out |
| `panel-shell.js`, `panel.css` | Gardener `src/ext/sidepanel/panel.js` (its toolbar markup, view switching) and `panel.css` (its panel base, toolbar, menu popover, full-height layout) | The account header became the optional `lead`; without it the Chat control leads; class names `gardener-*` became `chat-panel-*`; Gardener renders pixel-identically |
| `routines.js`, `routine-text.js`, `routines.css` | Gardener `src/ext/sidepanel/routines-view.js`, `routine-text.js` and `panel.css` (its Routine view rules) | Simplified first (no one-time runs, no run counts, no Model); the transport became `RoutineClient`, the name, permissions, run wording and the pause control `RoutineSlots`; class names `gardener-*` became `chat-*`; Gardener renders pixel-identically |

## Build tools (`tools/`)

| File | From | Notes |
| --- | --- | --- |
| `code-sandbox-build.js` | pi-do `scripts/build-sandbox.ts` (the shell Worker bundle, its node built-in stubs and content address) and `scripts/build-extension.ts` (the sandboxed page's script with its Worker inlined) | The product passes its esbuild and entries; pi-do's pinned shell is byte-identical |
