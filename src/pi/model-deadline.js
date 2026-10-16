// A model request bounded by a deadline, for a product whose model transport has none of its own:
// the Pi stream function gets an abort signal that also fires after the model's deadline, and a
// response that deadline cut ends as a MODEL_TIMEOUT failure (retryable), not as an abort, which
// Pi reports as "Request was aborted" and a turn could not tell from a cancel. From pi-do
// src/worker/model.ts.

/**
 * @param {(model: any, context: any, options: any) => any} streamFn
 * @param {number | ((model: any) => number)} deadlineMs per request, or per model
 */
export function withModelDeadline(streamFn, deadlineMs) {
  return (model, context, options = {}) => {
    const ms = typeof deadlineMs === "function" ? deadlineMs(model) : deadlineMs;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(Object.assign(new Error(`MODEL_TIMEOUT: model exceeded ${ms}ms`), { name: "TimeoutError" })), ms);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    // Pi reads the terminal message from `result()`; the same message object is rewritten in place.
    const settle = message => {
      clearTimeout(timer);
      if (deadline.signal.aborted && !options.signal?.aborted && message?.stopReason === "aborted") {
        Object.assign(message, { stopReason: "error", errorCode: "MODEL_TIMEOUT", errorMessage: `MODEL_TIMEOUT: model exceeded ${ms}ms` });
      }
      return message;
    };
    let source;
    try { source = streamFn(model, context, { ...options, signal }); }
    catch (error) { clearTimeout(timer); throw error; }
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of await source) {
          if (event.type === "error") yield { ...event, reason: settle(event.error).stopReason };
          else { if (event.type === "done") clearTimeout(timer); yield event; }
        }
      },
      result: async () => settle(await (await source).result()),
    };
  };
}
