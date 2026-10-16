// The model request lifecycle the turn driver's `modelEvent` reads (model.started, then
// model.completed, model.failed or model.cancelled), for a product whose model transport does not
// report it itself: the turn's lease follows a request in flight, and a completed request carries
// its estimated cost. From pi-do src/worker/turns.ts.

/**
 * Wraps a Pi stream function so each request reports its lifecycle to `modelEvent`.
 * @param {(model: any, context: any, options: any) => any} streamFn
 * @param {(event: string, detail: Record<string, unknown>) => void} modelEvent
 */
export function reportModelRequests(streamFn, modelEvent) {
  return (model, context, options) => {
    modelEvent("model.started", {});
    const stream = streamFn(model, context, options);
    Promise.resolve(stream).then(response => response.result()).then(message => {
      const event = message.stopReason === "error" ? "model.failed" : message.stopReason === "aborted" ? "model.cancelled" : "model.completed";
      const costUsd = message.usage?.cost?.total;
      modelEvent(event, { ...(Number.isFinite(costUsd) ? { costUsd } : {}), ...(message.errorCode ? { errorCode: message.errorCode } : {}) });
    }, () => modelEvent("model.failed", {}));
    return stream;
  };
}
