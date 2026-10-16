// One turn of the conversation as the user sees it: their message (with Edit), the progress steps
// ("How it worked"), the answer (or the answer so far), a handoff waiting for the user, and a
// failure with its code and Retry. A turn group is a user turn with the internal turns that
// continued it, and the messages the user sent while it ran that it took (steers): each is shown
// as delivered to that task, before the answer that replied to it. From X Gardener chat/index.jsx (TurnGroup, Turn, Message).
import React, { useEffect, useRef, useState } from "react";
import { canRetryTurn, isActiveTurnStatus } from "../runtime/projection.js";
import { useChatConfig } from "./config.js";
import { Markdown } from "./markdown.jsx";

export function TurnGroup({ turns, steers = [], onEdit, onRetry, onContinue, onCancel, retryTurnId, disabled }) {
  const { wording } = useChatConfig();
  const latest = turns.at(-1);
  const working = turns.some(turn => isActiveTurnStatus(turn.status));
  const [expanded, setExpanded] = useState(false);
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) setExpanded(false);
    wasWorking.current = working;
  }, [working]);
  const controls = { onEdit, onRetry, onContinue, onCancel, retryTurnId, disabled };
  if (turns.length === 1) return <Turn turn={latest} steers={steers} {...controls} />;
  return <>
    <UserTurnInput turn={turns[0]} onEdit={onEdit} disabled={disabled} />
    <details className="chat-turn-progress" open={working || expanded} onToggle={event => {
      if (!working) setExpanded(event.currentTarget.open);
    }}>
      <summary>{working ? wording.progressWorking : wording.progressDone} · {wording.steps(turns.length - 1)}</summary>
      {turns.slice(0, -1).map(turn => <Turn key={turn.turnId} turn={turn} hideInput />)}
    </details>
    <Turn turn={latest} steers={steers} hideInput {...controls} />
  </>;
}

function UserTurnInput({ turn, onEdit, disabled }) {
  const { wording, slots } = useChatConfig();
  if (!turn.input && !turn.images?.length) return null;
  // A product may show some inputs its own way (a recording's analysis request).
  const custom = slots.userInput?.(turn);
  if (custom) return custom;
  // A message the running task took is marked as delivered to it; it is not edited on its own.
  const steered = Boolean(turn.mergedIntoTurnId);
  return <div className="chat-user-turn"><Message message={{ role: 'user', text: turn.input || '', images: turn.images, createdAt: turn.createdAt }} />
    {steered && <small className="chat-steer-note">{wording.steered}</small>}
    {onEdit && !turn.internal && !steered && <button type="button" className="chat-message-edit" disabled={disabled} onClick={() => onEdit(turn)}>{wording.edit}</button>}
  </div>;
}

export function Turn({ turn, steers = [], hideInput = false, onEdit, onRetry, onContinue, onCancel, retryTurnId, disabled }) {
  const { wording } = useChatConfig();
  const working = isActiveTurnStatus(turn.status);
  const [expanded, setExpanded] = useState(working);
  useEffect(() => { setExpanded(working); }, [working]);
  // The final answer, or while the turn runs the answer so far when the product projects one.
  const answer = turn.finalAnswer || (working && turn.partialText) || null;
  const assistant = answer ? { role: "assistant", text: answer, createdAt: turn.completedAt || turn.updatedAt } : null;
  return <>{!hideInput && <UserTurnInput turn={turn} onEdit={onEdit} disabled={disabled} />}
    {(working || turn.progress?.items?.length > 0) && <details className="chat-turn-progress" open={expanded}
      onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary><span role={working ? "status" : undefined}>{working ? turn.progress?.label || wording.progressWaiting : wording.progressDone}</span></summary>
      {(turn.progress?.items || []).map(item => <p key={item.id}>
        <time dateTime={item.at}>{formatMessageTime(item.at)}</time> · {item.label}{item.tool ? ` · ${item.tool}` : ""}{item.errorCode ? ` · ${item.errorCode}` : ""}
      </p>)}
    </details>}
    {steers.map(steer => <UserTurnInput key={steer.turnId} turn={steer} />)}
    {assistant && <Message message={assistant} />}
    {turn.handoff && turn.turnId === retryTurnId && <div className="chat-state" role="status">
      <span>{wording.waitingForYou}</span>
      {onContinue && turn.turnId === retryTurnId && <button type="button" className="chat-turn-retry" disabled={disabled} onClick={onContinue}>{wording.carryOn}</button>}
      {onCancel && <button type="button" className="chat-turn-retry" disabled={disabled} onClick={() => onCancel(turn)}>{wording.cancelTask}</button>}
    </div>}{["failed", "cancelled"].includes(turn.status) && <div className="chat-state is-error" role="status">
      {wording.failure(turn)}
      {turn.errorCode && <small className="chat-turn-error-code">{turn.errorCode}</small>}
      {onRetry && canRetryTurn(turn, retryTurnId) && <button type="button" className="chat-turn-retry" disabled={disabled} onClick={() => onRetry(turn)}>{wording.retry}</button>}
    </div>}</>;
}

/** One message bubble: who, when, a user message's images (each opens full size), and the text as safe Markdown. */
export function Message({ message }) {
  const { wording, slots } = useChatConfig();
  const timestamp = messageTimestamp(message.createdAt);
  return <article className={`chat-message is-${message.role}`}>
    <div><span>{message.role === "user" ? wording.you : wording.assistant}</span>{timestamp && <time dateTime={timestamp}>{formatMessageTime(timestamp)}</time>}</div>
    {message.images?.length > 0 && <MessageImages images={message.images} />}
    {message.text && <section><Markdown text={message.text} media={slots.markdown} /></section>}
  </article>;
}

// A sent message's images: each opens full size in a new tab; one the product could not load is
// still counted, by its label.
function MessageImages({ images }) {
  const { wording } = useChatConfig();
  return <ul className="chat-message-images">
    {images.map((image, index) => <li key={index}>{image.src
      ? <a href={image.src} target="_blank" rel="noreferrer" title={wording.openImage}><img src={image.src} alt={wording.imageAlt(index + 1)} /></a>
      : <span>{wording.imageAlt(index + 1)}</span>}</li>)}
  </ul>;
}

function messageTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function formatMessageTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
