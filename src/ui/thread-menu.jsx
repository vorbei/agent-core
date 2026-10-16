// The thread list: a menu with New chat and the product's listed threads (newest first as the
// client returns them, in the product's groups when it names them, Chats first), each under the
// product's title and mark when it gives them, with its latest turn's state and time, the current
// one marked, each deletable unless it is working. From X Gardener chat/index.jsx (ChatMenu,
// ThreadGroup, ThreadRow).
import React from "react";
import { isActiveTurnStatus } from "../runtime/projection.js";
import { useChatConfig } from "./config.js";

export function ThreadMenu({ threads, activeThreadId, onSelect, onCreate, onDelete, deletingThreadId }) {
  const { wording, slots } = useChatConfig();
  const listed = threads.filter(thread => slots.listed ? slots.listed(thread) : true);
  // Chats first, then each group the product names, in the order its first thread comes.
  const groups = new Map([[wording.chats, []]]);
  for (const thread of listed) {
    const label = slots.threadGroup?.({ thread, threads }) || wording.chats;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(thread);
  }
  return <div className="chat-thread-menu" role="menu" aria-label={wording.chats}>
    <button className="chat-thread-new" type="button" role="menuitem" onClick={onCreate}><span aria-hidden="true"><PlusIcon /></span><strong>{wording.newChat}</strong></button>
    {[...groups].map(([label, items]) => <ThreadGroup key={label} label={label} threads={items} all={threads} activeThreadId={activeThreadId}
      onSelect={onSelect} onDelete={onDelete} deletingThreadId={deletingThreadId} />)}
  </div>;
}

export function ThreadGroup({ label, threads, all = threads, activeThreadId, onSelect, onDelete, deletingThreadId }) {
  if (!threads.length) return null;
  return <section className="chat-thread-group" role="group" aria-label={label}>
    <header>{label}</header>
    {threads.map((thread) => <ThreadRow key={thread.threadId} thread={thread} threads={all} activeThreadId={activeThreadId}
      onSelect={onSelect} onDelete={onDelete} deletingThreadId={deletingThreadId} />)}
  </section>;
}

function ThreadRow({ thread, threads, activeThreadId, onSelect, onDelete, deletingThreadId }) {
  const { wording, slots } = useChatConfig();
  const time = thread.latestTurnUpdatedAt || thread.updatedAt || thread.createdAt;
  const label = slots.threadLabel?.({ thread, threads }) || {};
  const title = label.title || threadTitle(thread, wording);
  const working = isActiveTurnStatus(thread.latestTurnStatus);
  const status = thread.latestTurnStatus && wording.threadStatus?.[thread.latestTurnStatus];
  return <div className="chat-thread-item"><button type="button" role="menuitem" aria-current={thread.threadId === activeThreadId ? "true" : undefined} onClick={() => onSelect(thread.threadId)}>
    <span className="chat-thread-check" aria-hidden="true">{thread.threadId === activeThreadId && <svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 6 9 17l-5-5" /></svg>}</span>
    <span className="chat-thread-label"><span className="chat-thread-title"><strong>{title}</strong>{label.mark}</span><span className="chat-thread-meta">{status && <span className={`chat-thread-status is-${threadStatusKind(thread.latestTurnStatus)}`}>{status}</span>}<time dateTime={time}>{formatThreadTime(time)}</time></span></span>
  </button>{onDelete && <button className="chat-thread-delete" type="button" role="menuitem" aria-label={wording.deleteChatNamed(title)}
    disabled={Boolean(deletingThreadId) || working}
    title={working ? wording.deleteBusy : wording.deleteChat}
    aria-busy={deletingThreadId === thread.threadId} onClick={() => onDelete(thread)}><DeleteIcon /></button>}</div>;
}

// How a state reads at a glance: finished quiet, running in the accent, waiting in the warning
// color, failed in the danger color.
function threadStatusKind(status) {
  if (status === "failed") return "failed";
  if (status === "waiting_for_approval" || status === "waiting_for_browser") return "waiting";
  return isActiveTurnStatus(status) ? "running" : "done";
}

function PlusIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" d="M12 5v14M5 12h14" /></svg>;
}

function DeleteIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 11v6m4-6v6m5-11v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>;
}

/** A thread's title, or "Chat · <when it was created>". */
export function threadTitle(thread, wording) {
  return thread?.title || (thread?.createdAt ? wording.chatTitle(formatThreadDate(thread.createdAt)) : "Chat");
}

function formatThreadDate(value) {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T12:00:00`) : new Date(value);
  return parsed.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatThreadTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
