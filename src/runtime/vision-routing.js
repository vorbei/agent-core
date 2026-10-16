// A turn reads images it was not started with when a tool returns one (a screenshot of a page or
// a phone). The model request that answers such a result goes to the vision model: the text model
// reads images poorly or not at all. So does a request answering any step the vision model took
// other than a text read: a tap, a key, a code run. Such a step was decided from what it saw, and
// only it can judge the result on a screen the text tree does not describe (a board, a canvas).
// The text model, which did not see it, reasons blind instead: in one measured run it spent 69 s and
// 77 s (10-13K reasoning tokens, one 120 s timeout) on the results of the vision model's chess taps,
// and in another it looked again first after 8 of 9 of its code runs. The text model takes over when
// each of the vision model's last calls was a text read, and keeps the turn while its own steps
// continue: a routine step (a snapshot, a tap on a ref, the answer) takes it about 2.3 s where the
// vision model takes about 4.5 s even when it barely reasons.
// A text read is a call whose result describes itself in text, so judging it needs no picture. By
// default that is a browser read of the page as text (a snapshot, a text read, the tab list); a
// product adds its own (`textRead`): a server read with no page input (a web fetch), or a domain
// script whose result carries its own verified outcome and state. In one measured run seven of the
// eleven requests of a chess turn stayed on the vision model answering such steps ($0.187).
// A text-model request sees each tool image as
// a stub; a new screenshot is how it looks again (its result routes the next request to vision).
// A turn whose own message carried images runs on the vision model throughout and needs no routing.
// So does a turn whose text model reads screenshots itself: the product passes no vision model, and
// every request keeps its images (a multimodal text model reads UI pictures as well as the vision
// model at a fraction of the cost, but picks small coordinate targets poorly, which a product can give
// to the vision model as a separate one-shot call).

const IMAGE_STUB = "[Image not shown in this request: the reply after this result was made while looking at it. Take a new screenshot to see the screen again.]";
// Browser actions whose result is the page as text: the text model can read it as well as the vision model.
const TEXT_READS = new Set(["tabs", "select_tab", "snapshot", "read_text"]);
/** The default text read (needsVision): a browser call whose result is the page as text. */
export const browserTextRead = (call) => call?.name === "browser" && TEXT_READS.has(call.arguments?.action);

const hasImage = (message) => Array.isArray(message?.content) && message.content.some((block) => block?.type === "image");

/**
 * Whether the request answering `messages` needs the vision model (`visionModelId`): a tool result
 * after the last assistant message carries an image, or that assistant message is the vision
 * model's and one of its calls was not a text read: `textRead(call, result)` is false, `result`
 * being the call's toolResult message when there is one (browserTextRead by default). Only the
 * current turn counts: a message older than `since` (the turn's start, ms) is an earlier turn's, so
 * a turn that begins after one cut off on a vision step starts on the text model.
 */
export function needsVision(messages = [], visionModelId = null, textRead = browserTextRead, since = -Infinity) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user" && Number(message?.timestamp) < since) return false;
    if (message?.role === "toolResult" && hasImage(message)) return true;
    if (message?.role !== "assistant") continue;
    if (visionModelId === null || message.model !== visionModelId) return false;
    const calls = Array.isArray(message.content) ? message.content.filter((block) => block?.type === "toolCall") : [];
    const results = messages.slice(index + 1).filter((next) => next?.role === "toolResult");
    return calls.some((call) => !textRead(call, results.find((result) => result.toolCallId === call.id)));
  }
  return false;
}

/**
 * The text model's view: every tool-result image becomes the stub (one per result). The stub
 * depends only on the message, so the text model's cached prefix stays byte-identical.
 * @returns {any[]} the same array when no tool result carries an image
 */
export function withoutToolImages(messages = []) {
  if (!messages.some((message) => message?.role === "toolResult" && hasImage(message))) return messages;
  return messages.map((message) => message?.role !== "toolResult" || !hasImage(message) ? message : {
    ...message, content: [...message.content.filter((block) => block?.type !== "image"), { type: "text", text: IMAGE_STUB }]
  });
}

/**
 * The stream function a turn hands Pi: a request that needs the vision model (needsVision, with the
 * product's `textRead`) goes to it, every other request to the text model with tool images stubbed.
 * Each side is { model, streamFn } (a product's own transport). Without a vision model (a turn already
 * on it, or a text model that reads images) nothing is rerouted or stubbed.
 * @param {{ text: { model: any, streamFn: Function }, vision?: { model: any, streamFn: Function } | null,
 *   onRoute?: (route: "vision") => void, textRead?: (call: any, result?: any) => boolean, since?: number }} options
 *   `since`: the turn's start (ms); an earlier turn's last step never routes this one.
 *   `affordable(visionModel, context)`: false keeps a request that needs the vision model on the
 *   text model (images stubbed): the vision model's price on a long uncached context can pass the
 *   turn's whole spend ceiling in one request (measured 2026-10-14: $0.46-0.91 each in a $0.50 turn),
 *   which a spend check after the response cannot undo.
 */
export function routeVisionRequests({ text, vision = null, onRoute = () => {}, textRead = browserTextRead, since = -Infinity, affordable = () => true }) {
  return (model, context, options) => {
    if (!vision) return text.streamFn(model, context, options);
    if (needsVision(context?.messages, vision.model.id, textRead, since) && affordable(vision.model, context)) {
      onRoute("vision");
      return vision.streamFn(vision.model, context, options);
    }
    return text.streamFn(model, { ...context, messages: withoutToolImages(context?.messages) }, options);
  };
}
