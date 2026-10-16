// The tool result that stands in the journal for a call its executor has not run yet (the call
// queue's waiting result), and how the attempt recognizes one. The text and details are X
// Gardener's stored form (src/pi/function-step.js), kept verbatim: they are journal data.

/** The text of a waiting result; a restore replaces such a result with the call's outcome. */
export const WAITING_RESULT_PREFIX = "Waiting for account function";

/**
 * The result a tool call holds while its executor call runs; it ends the model's tool batch. Every
 * product builds its waiting results here, so the run's end at a waiting call (`awaitsExecutor`)
 * reads one shape. `status` is the call row's: `created`, or `claimed` when an executor already
 * holds a call an earlier attempt queued (a replayed write).
 */
export function executorWaitingResult({ callId, functionName, status = "created" }) {
  return { content: [{ type: "text", text: `${WAITING_RESULT_PREFIX} ${callId}` }],
    details: { callId, functionName, executor: "extension", status }, terminate: true };
}

/** Whether a tool result message waits for its executor. */
export const awaitsExecutor = message => message?.details?.executor === "extension" && ["created", "claimed"].includes(message.details.status);
