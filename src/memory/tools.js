// The model's long-term memory tools (search_memory, remember, forget_memory) as both products run
// them: which of them a message's permission offers, the permission each call needs, and the
// model's side of each call. What the model saves is always agent-sourced (only the user confirms
// an instruction, in the product's Memory view), and the model's forget never removes a memory the
// user confirmed (no `userInitiated`). Schemas, descriptions, receipts and result shapes are the
// product's. From pi-do src/worker/memory-tools.ts and X Gardener's server tools (step 6).
import { MemoryError, forgetMemory, remember, rememberPermission, searchMemory } from "./store.js";

export const MEMORY_TOOL_NAMES = Object.freeze(["search_memory", "remember", "forget_memory"]);

/** The permission a memory tool call needs: "update" to change or forget a memory, else null. */
export function memoryToolPermission(name, input) {
  if (name === "search_memory") return null;
  if (name === "remember") return rememberPermission(input || {});
  if (name === "forget_memory") return "update";
  throw new MemoryError("MEMORY_INVALID", `${name} is not a memory tool`);
}

/** The memory tools a permission offers: search and remember always (a new instruction needs no permission), forget with `update`. */
export function offeredMemoryTools(permission) {
  return MEMORY_TOOL_NAMES.filter(name => name !== "forget_memory" || permission?.update === true);
}

/** agent-core's memory store on `storage`, as `runMemoryTool` calls it; a product may route a kind of memory elsewhere. */
export function memoryStore(storage) {
  return {
    search: input => searchMemory(storage, input),
    remember: input => remember(storage, input),
    forget: memoryId => forgetMemory(storage, memoryId),
  };
}

/**
 * Runs one memory tool call for the model, after the product's permission check
 * (`memoryToolPermission`) and inside its receipt. `store` is `memoryStore(storage)` or the
 * product's routing over it.
 */
export function runMemoryTool(store, name, input, { turnId } = {}) {
  if (name === "search_memory") return store.search(input);
  if (name === "remember") return store.remember({ ...input, sourceType: "agent", ...(turnId ? { turnId } : {}) });
  if (name === "forget_memory") return store.forget(input.memoryId);
  throw new MemoryError("MEMORY_INVALID", `${name} is not a memory tool`);
}
