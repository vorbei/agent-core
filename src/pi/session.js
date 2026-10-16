// Opens a pi-coding-agent session for one attempt: a temp working directory, the host's model
// transport registered as Pi's provider (no credentials stored), the attempt's extensions, and the
// branch journal loaded from the checkpoint; snapshots are incremental and advance only after the
// host committed them. From X Gardener src/pi/session.js.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Settings } from "typebox/system";
import { loadJournal, reconcileMessages, snapshotJournal } from "./journal.js";

// Original TypeBox's interpreter, not a replacement validator. The Worker build
// resolves this import to the same shrinkwrapped instance used by Pi.
Settings.Set({ useAcceleration: false });

export async function openPiSession({ model, streamFn, systemPrompt, messages, piSession, sessionId, extensions, compaction = { enabled: false } }) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-session-"));
  let session;
  let extensionError;
  // Pi appends this per-session temp directory to the system prompt. The model has
  // no filesystem, and a random suffix there changes the system prompt on every
  // resumed session, which ends the provider's cached prefix before the history.
  // Stripped here, per request: continuation turns skip before_agent_start.
  const cwdLine = `\nCurrent working directory: ${cwd.replace(/\\/g, "/")}\n`;
  const stream = (model, context, options) => {
    if (extensionError) throw new Error(`PI_EXTENSION_FAILED: ${extensionError.error}`);
    const systemPrompt = context?.systemPrompt?.endsWith(cwdLine) ? context.systemPrompt.slice(0, -cwdLine.length) : context?.systemPrompt;
    return streamFn(model, systemPrompt === context?.systemPrompt ? context : { ...context, systemPrompt }, options);
  };
  const dispose = () => { session?.dispose(); rmSync(cwd, { recursive: true, force: true }); };
  try {
    const settingsManager = SettingsManager.inMemory({
      compaction, retry: { enabled: false },
      images: { autoResize: false }
    });
    const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"),
      modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt, extensionFactories: [pi => {
        // Credentials/bindings are already captured by the host's configured
        // transport. Register native ambient auth; never invent/store an API key.
        pi.registerProvider({ id: model.provider, name: model.provider, baseUrl: model.baseUrl,
          getModels: () => [model], stream, streamSimple: stream,
          auth: { apiKey: { name: "Host transport", async resolve() {
            return { auth: {}, source: "host-configured transport" };
          } } }
        });
      }, ...extensions]
    });
    await resourceLoader.reload();
    const errors = resourceLoader.getExtensions().errors;
    if (errors.length) throw new Error(`PI_EXTENSION_LOAD_FAILED: ${errors.map(item => item.error).join("; ")}`);
    const manager = loadJournal(cwd, piSession, sessionId);
    if (messages !== undefined) reconcileMessages(manager, messages);
    ({ session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime,
      noTools: "builtin", settingsManager, resourceLoader, sessionManager: manager }));
    await session.bindExtensions({ mode: "rpc", onError: error => {
      // Extension failures must not silently turn a failed evidence/context check
      // into a successful delivery. The caller checks this after execution.
      extensionError = error;
    } });
    session.agent.toolExecution = "sequential";
    // The native JSONL journal is append-only, so entries past the last committed
    // count are exactly the increment. `commit` advances only after the host has
    // durably written that snapshot; a failed write re-sends the same entries.
    let committed = 0;
    return { session, dispose, getExtensionError: () => extensionError,
      snapshot(currentMessages, { incremental = false } = {}) {
        reconcileMessages(manager, currentMessages);
        if (!incremental) return snapshotJournal(manager);
        const entries = manager.getEntries();
        return structuredClone({ header: manager.getHeader(), leafId: manager.getLeafId(),
          entries: entries.slice(committed), incrementalFrom: committed, entryCount: entries.length });
      },
      commit(snapshot) { if (Number.isInteger(snapshot?.entryCount)) committed = Math.max(committed, snapshot.entryCount); } };
  } catch (error) { dispose(); throw error; }
}
