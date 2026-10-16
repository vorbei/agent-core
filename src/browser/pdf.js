// Chrome's built-in PDF viewer: detecting it (it takes no input from the agent), and telling a
// navigation that ended in a debugger detach (the viewer detaches it as the PDF commits) from a failure.

/** @typedef {import("./index.js").Send} Send */

/** Whether the tab's main document is Chrome's PDF viewer. @param {Send} send */
export async function isPdfViewer(send) {
  return (await send("Page.getFrameTree")).frameTree?.frame?.mimeType === "application/pdf";
}

/** Whether two URLs name the same document (the fragment is ignored). @param {string} actual @param {string} requested */
export function sameDocument(actual, requested) {
  try { const a = new URL(actual), b = new URL(requested); a.hash = b.hash = ""; return a.href === b.href; } catch { return false; }
}

/** The model-facing refusal for input sent to the PDF viewer, naming the action that reads it. @param {string} readAction */
export function pdfViewerInputMessage(readAction) {
  return `Nothing was sent: Chrome's PDF viewer takes no clicks, keys or typing from the agent. ${readAction} returns the PDF text with --- page N --- markers; to show page N, navigate to the PDF URL with #page=N. Selecting or highlighting PDF text is not supported.`;
}
