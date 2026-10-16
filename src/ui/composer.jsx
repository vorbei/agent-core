// The message box: Enter sends (not while an IME is composing; Shift+Enter is a new line), a
// message sent while a turn runs steers it, Stop cancels the running turn, and the product's
// settings (permissions, preferences) sit in a popover beside it. When the product accepts images,
// an image pasted into the box or dropped on it is attached: its thumbnail shows above the text with
// a remove button. From X Gardener chat/index.jsx.
import React, { useState } from "react";
import { useChatConfig } from "./config.js";
import { ComposerSettings } from "./composer-settings.jsx";
import { dragHasFiles, imageFilesOf } from "./image-attachments.js";

export function Composer({ text, onText, onSubmit, inputRef, settings, stoppable, stopping, onStop, sendDisabled, images, onImages, onRemoveImage }) {
  const { wording } = useChatConfig();
  const [dragging, setDragging] = useState(false);
  // Only a product that accepts images takes a drop; otherwise the browser's default stays.
  const drop = onImages ? {
    onDragEnter: event => { if (dragHasFiles(event.dataTransfer)) { event.preventDefault(); setDragging(true); } },
    onDragOver: event => { if (dragHasFiles(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } },
    onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); },
    onDrop: event => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDragging(false);
      onImages([...(event.dataTransfer.files || [])]);
    },
  } : {};
  return <form className={`chat-composer${dragging ? " is-dragging" : ""}`} onSubmit={onSubmit} {...drop}>
    <div className="chat-composer-input">
      {images?.length > 0 && <ul className="chat-composer-images" aria-label={wording.attachedImages}>
        {images.map((image, index) => <li key={image.id}>
          <img src={image.src} alt={wording.imageAlt(index + 1)} />
          <button type="button" aria-label={wording.removeImage(index + 1)} title={wording.removeImage(index + 1)}
            onClick={() => { onRemoveImage(image.id); inputRef.current?.focus(); }}><CloseIcon /></button>
        </li>)}
      </ul>}
      <textarea ref={inputRef} rows="1" maxLength="4000" value={text} onChange={(event) => onText(event.target.value)} onKeyDown={(event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        onSubmit(event);
      }} onPaste={(event) => {
        // A pasted image is attached; pasted text is left to the box.
        const files = onImages ? imageFilesOf(event.clipboardData) : [];
        if (!files.length) return;
        event.preventDefault();
        onImages(files);
      }} placeholder={wording.placeholder} aria-label={wording.placeholder} />
    </div>
    {settings && <ComposerSettings trigger={<MoreIcon />} label={wording.settings}>{settings}</ComposerSettings>}
    {stoppable && <button className="chat-composer-action" type="button" disabled={stopping}
      aria-label={stopping ? wording.stopping : wording.stop} title={wording.stopTitle} onClick={onStop}><StopIcon /></button>}
    <button className="chat-composer-action" type="submit" disabled={sendDisabled} aria-label={wording.send}><SendIcon /></button>
  </form>;
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>;
}

// Every composer control is a 32 px icon, so Stop joins Send on the one row at any panel width.
function StopIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></svg>;
}

function MoreIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>;
}
