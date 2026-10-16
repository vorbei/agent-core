// The one error type of the browser layer: a stable machine code plus a model-readable message.

export class BrowserCoreError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "BrowserCoreError";
    this.code = code;
  }
}
