// Every user-visible string of the shared chat, with the defaults a product overrides through
// `ChatSlots.wording` (its assistant's name, its failure and error messages, its language). The
// defaults are X Gardener's English chat strings with its product name taken out.

/** @param {string} assistant */
export function defaultWording(assistant = "Assistant") {
  return {
    assistant,
    you: "You",
    placeholder: `Message ${assistant}`,
    working: `${assistant} is working…`,
    connecting: `Connecting to ${assistant}…`,
    welcome: "Ask a question or describe a task.",
    connectFailedTitle: "Chat could not connect",
    connectFailed: "Reload and try again.",
    noChat: "No chat selected.",
    newChat: "New chat",
    chats: "Chats",
    /** A thread's latest turn state, on its row in the thread list. */
    threadStatus: { queued: "Queued", running: "Running", waiting_for_browser: "Waiting for the browser", waiting_for_approval: "Waiting for approval",
      completed: "Completed", failed: "Failed", cancelled: "Stopped" },
    chatTitle: (date) => `Chat · ${date}`,
    deleteChat: "Delete chat",
    deleteChatNamed: (title) => `Delete ${title}`,
    deleteBusy: "Finish or cancel this work first",
    deleteConfirm: (title) => `Delete “${title}”? It will be removed from Chats.`,
    deleteFailed: (message) => message || "Could not delete chat.",
    loadFailed: (message) => message || "Could not load chats.",
    createFailed: "Could not create a new chat.",
    syncFailed: "Could not sync the chat. What you see below may be out of date; it will retry on its own.",
    sendFailed: (message) => message || "Could not start this turn.",
    loadEarlier: "Load earlier messages",
    loadingEarlier: "Loading…",
    loadEarlierFailed: (message) => message || "Could not load earlier messages.",
    edit: "Edit",
    editNotice: "Edit and send again · the original message and history are kept",
    cancelEdit: "Cancel edit",
    /** Under a message the running task took while it worked; that task's answer replies to it. */
    steered: "Added to the running task",
    progressWorking: "Working",
    progressWaiting: "Waiting to run",
    progressDone: "How it worked",
    steps: (count) => `${count} steps`,
    waitingForYou: "Waiting for you",
    carryOn: "Done, carry on",
    carryOnText: "I have done what you asked. Read the original tab again, then carry on with the unfinished task.",
    cancelTask: "Cancel task",
    retry: "Retry",
    retryFailed: (message) => `Could not retry: ${message}`,
    stop: "Stop",
    stopping: "Stopping…",
    stopTitle: "Stops the current turn; what already ran is not undone",
    stopFailed: (message) => `The stop was not confirmed: ${message}. You can stop again; no new task is created.`,
    send: "Send message",
    settings: "Chat settings",
    /** Images pasted or dropped on the message box (only when the product accepts images). */
    attachedImages: "Attached images",
    imageAlt: (number) => `Image ${number}`,
    removeImage: (number) => `Remove image ${number}`,
    openImage: "Open the full image",
    imageLimit: (max) => `Up to ${max} images per message; the rest were not attached.`,
    imageType: "Only PNG, JPEG or WebP images can be attached.",
    imageFailed: "This image could not be read, so it was not attached.",
    dismiss: "Dismiss",
    /** The line under a failed or cancelled turn; the error code is shown beside it. */
    failure: (turn) => turn.status === "cancelled" ? "This turn was stopped. What already ran is kept above." : "This turn did not finish."
  };
}

/** @typedef {ReturnType<typeof defaultWording>} ChatWording */
