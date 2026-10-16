// The chat of one account over a ChatClient: restores the selected thread, follows the thread's
// turns (the newest page refreshed on each change the client reports, older pages on request),
// sends a message (a steer while a turn runs) with the images attached to it, edits, retries,
// stops, and creates, selects and deletes threads through the thread menu. Product parts render
// through ChatSlots. From X
// Gardener chat/index.jsx (ChatHost, ConnectedChat).
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { canRetryTurn, canStopTurn, isActiveTurnStatus } from "../runtime/projection.js";
import { useChatConfig } from "./config.js";
import { groupTurns } from "./turn-groups.js";
import { TurnGroup } from "./turn.jsx";
import { ThreadMenu, threadTitle } from "./thread-menu.jsx";
import { Composer } from "./composer.jsx";
import { IMAGE_INPUT_TYPES, IMAGE_LIMITS, prepareChatImage } from "./image-attachments.js";

export const THREAD_LIST_LIMIT = 20;
export const TURN_PAGE_SIZE = 50;

export function ChatHost({ account, client, menu, inputRef, composerRequest, threadRequest, pageSize = TURN_PAGE_SIZE }) {
  if (!account) return null;
  return <ChatErrorBoundary key={account.accountId}>
    <ConnectedChat account={account} client={client} menu={menu} inputRef={inputRef} pageSize={pageSize}
      composerRequest={composerRequest} threadRequest={threadRequest} />
  </ChatErrorBoundary>;
}

class ChatErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <ChatFailure error={this.state.error} />;
  }
}

function ChatFailure({ error }) {
  const { wording } = useChatConfig();
  return <div className="chat-error" role="alert"><strong>{wording.connectFailedTitle}</strong><p>{error.message || wording.connectFailed}</p></div>;
}

function ConnectedChat({ account, client: makeClient, menu, inputRef, pageSize, composerRequest, threadRequest }) {
  const { wording, slots } = useChatConfig();
  const [client] = useState(() => makeClient(account));
  const listed = (thread) => slots.listed ? slots.listed(thread) : true;
  const [text, setText] = useState("");
  // Images attached to the next message (only when the product accepts images), and a line saying
  // why one was not attached.
  const [images, setImages] = useState([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const preparingRef = useRef(0);
  const [preparing, setPreparing] = useState(0);
  const [imageNotice, setImageNotice] = useState("");
  const [editing, setEditing] = useState(null);
  const retryKeys = useRef(new Map());
  const [turns, setTurns] = useState([]);
  const [history, setHistory] = useState({ threadId: null, items: [], nextBefore: null, loading: false });
  const [threadId, setThreadId] = useState(null);
  const [threads, setThreads] = useState([]);
  const [initializing, setInitializing] = useState(true);
  const [error, setError] = useState("");
  const [syncFailed, setSyncFailed] = useState({ turns: false, threads: false });
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(null);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState(null);
  const deletedThreadIds = useRef(new Set());
  const selectedThreadRef = useRef(threadId);
  selectedThreadRef.current = threadId;
  const messagesRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const endRef = useRef(null);
  const turnsRevisionRef = useRef("");
  const latestPageRef = useRef({ threadId: null, items: [] });
  const activeThread = threads.find((thread) => thread.threadId === threadId);
  const visibleTurns = [...new Map([...(history.threadId === threadId ? history.items : []), ...turns].map(turn => [turn.turnId, turn])).values()];
  // A product may show a thread as read-only (no composer, no edit or retry) with a banner and notice.
  const view = (activeThread && slots.threadView?.({ thread: activeThread, threads, turns: visibleTurns })) || {};
  const readOnly = Boolean(view.readOnly);
  const stoppableTurn = visibleTurns.findLast(canStopTurn);
  // The thread's latest turn for Retry and Carry on: a steer the running turn took is part of that turn.
  const latestTurnId = visibleTurns.findLast(turn => !turn.mergedIntoTurnId)?.turnId;
  const busy = submitting || Boolean(stopping)
    || (!syncFailed.threads && isActiveTurnStatus(activeThread?.latestTurnStatus))
    || (!syncFailed.turns && visibleTurns.some((turn) => isActiveTurnStatus(turn.status)));
  const focusInput = () => inputRef.current?.focus();
  const compose = (value) => { setText(value); focusInput(); };

  useEffect(() => {
    let cancelled = false;
    void restoreChatState().then((restored) => {
      if (cancelled) return;
      setThreads(restored.threads);
      setThreadId(restored.threadId);
    }).catch((cause) => {
      if (!cancelled) setError(wording.loadFailed(cause.message));
    }).finally(() => {
      if (!cancelled) setInitializing(false);
    });
    return () => { cancelled = true; };
  }, [account.accountId]);

  useEffect(() => {
    const { trigger, root } = menu || {};
    if (!trigger || !root) return undefined;
    const toggle = () => setThreadMenuOpen((open) => !open);
    const close = (event) => {
      if (!trigger.contains(event.target) && !root.contains(event.target)) setThreadMenuOpen(false);
    };
    const escape = (event) => { if (event.key === "Escape") setThreadMenuOpen(false); };
    trigger.addEventListener("click", toggle);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      trigger.removeEventListener("click", toggle);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [account.accountId, menu]);

  useEffect(() => {
    menu?.trigger?.setAttribute("aria-expanded", String(threadMenuOpen));
  }, [threadMenuOpen]);

  // The shell's Chat control names the open chat (a new chat has no title yet).
  const activeTitle = activeThread ? slots.threadLabel?.({ thread: activeThread, threads })?.title || activeThread.title || "" : "";
  useEffect(() => {
    const slot = menu?.trigger?.querySelector?.("[data-chat-title]");
    if (slot) slot.textContent = activeTitle;
  }, [activeTitle, menu]);

  useEffect(() => {
    if (!composerRequest.revision) return;
    setText(composerRequest.text);
    requestAnimationFrame(focusInput);
  }, [composerRequest.revision]);

  useEffect(() => {
    if (!threadRequest.revision || !threadRequest.threadId) return;
    void selectThread(threadRequest.threadId);
  }, [threadRequest.revision]);

  useEffect(() => {
    if (!threadId) return undefined;
    let cancelled = false;
    const load = async () => {
      const [turnResult, threadResult] = await Promise.allSettled([
        client.listTurns(threadId, { limit: pageSize }),
        client.listThreads({ limit: THREAD_LIST_LIMIT })
      ]);
      const failures = { turns: turnResult.status !== "fulfilled", threads: threadResult.status !== "fulfilled" };
      if (!cancelled) {
        setSyncFailed(failures);
        if (failures.turns || failures.threads) setError(wording.syncFailed);
        else setError(current => current === wording.syncFailed ? '' : current);
      }
      if (!cancelled && !deletedThreadIds.current.has(threadId) && !failures.turns) {
        const items = turnResult.value.items || [];
        const previous = latestPageRef.current.threadId === threadId ? latestPageRef.current.items : [];
        latestPageRef.current = { threadId, items };
        setHistory(current => current.threadId === threadId && (current.items.length || current.loading)
          ? { ...current, items: [...new Map([...current.items, ...previous].map(turn => [turn.turnId, turn])).values()] }
          : { threadId, items: [], nextBefore: turnResult.value.nextBefore || null, loading: false });
        const revision = JSON.stringify(items.map((turn) => [turn.turnId, turn.status, turn.updatedAt, turn.finalAnswer, turn.progress, turn.partialText]));
        if (revision !== turnsRevisionRef.current) {
          turnsRevisionRef.current = revision;
          setTurns(items);
        }
      }
      if (!cancelled && !failures.threads) setThreads((threadResult.value || []).filter(thread => !deletedThreadIds.current.has(thread.threadId)));
    };
    const unsubscribe = client.subscribe(load);
    return () => { cancelled = true; unsubscribe(); };
  }, [account.accountId, threadId]);

  async function loadOlderTurns() {
    if (history.threadId !== threadId || !history.nextBefore || history.loading) return;
    const requestedThread = threadId;
    const viewport = messagesRef.current;
    const height = viewport?.scrollHeight || 0;
    const top = viewport?.scrollTop || 0;
    stickToBottomRef.current = false;
    setHistory(current => ({ ...current, loading: true }));
    let page = null, failure = null;
    try { page = await client.listTurns(threadId, { before: history.nextBefore, limit: pageSize }); }
    catch (cause) { failure = cause; }
    if (selectedThreadRef.current !== requestedThread) return;
    setHistory(current => ({ ...current, loading: false, ...(page ? {
      items: [...(page.items || []), ...current.items], nextBefore: page.nextBefore || null
    } : {}) }));
    if (failure) setError(wording.loadEarlierFailed(failure.message));
    requestAnimationFrame(() => {
      if (selectedThreadRef.current === requestedThread && viewport) viewport.scrollTop = top + viewport.scrollHeight - height;
    });
  }

  useLayoutEffect(() => {
    if (stickToBottomRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [visibleTurns, busy]);
  function trackMessageScroll(event) {
    const viewport = event.currentTarget;
    stickToBottomRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 48;
  }
  // Pasted or dropped files: each supported image is prepared (downscaled, re-encoded) and attached
  // up to the product's count; one that is refused is named in the notice, never dropped silently.
  async function attachImages(files) {
    const limits = { ...IMAGE_LIMITS, ...slots.images };
    const supported = files.filter((file) => IMAGE_INPUT_TYPES.includes(file.type));
    const room = Math.max(0, limits.max - imagesRef.current.length - preparingRef.current);
    const accepted = supported.slice(0, room);
    setImageNotice(supported.length < files.length ? wording.imageType : supported.length > room ? wording.imageLimit(limits.max) : "");
    if (!accepted.length) return;
    const pending = (change) => { preparingRef.current += change; setPreparing(preparingRef.current); };
    pending(accepted.length);
    const prepare = slots.images.prepare || ((file) => prepareChatImage(file, limits));
    await Promise.all(accepted.map(async (file) => {
      try {
        const image = await prepare(file);
        setImages((current) => [...current, { mimeType: image.mimeType, data: image.data, src: image.src, id: crypto.randomUUID() }]);
      } catch (cause) {
        setImageNotice(cause?.message === "IMAGE_TYPE_UNSUPPORTED" ? wording.imageType : wording.imageFailed);
      } finally { pending(-1); }
    }));
  }

  function removeImage(id) {
    const removed = imagesRef.current.find((image) => image.id === id);
    if (removed?.src?.startsWith("blob:")) URL.revokeObjectURL(removed.src);
    setImages((current) => current.filter((image) => image.id !== id));
    setImageNotice("");
  }

  async function submit(event, suppliedText) {
    event.preventDefault();
    const value = (suppliedText ?? text).trim();
    // Carry on sends its own text; attached images wait for the user's own next message.
    const attached = suppliedText === undefined ? images : [];
    if ((!value && !attached.length) || submitting || stopping || readOnly || preparing) return;
    stickToBottomRef.current = true;
    if (suppliedText === undefined) setText("");
    if (attached.length) setImages([]);
    setImageNotice("");
    setError("");
    setSubmitting(true);
    const shown = attached.map(({ mimeType, src }) => ({ mimeType, src }));
    const withImages = shown.length ? { images: shown } : {};
    const optimistic = { turnId: crypto.randomUUID(), input: value, status: "queued", createdAt: new Date().toISOString(), ...withImages };
    setTurns((current) => [...current, optimistic]);
    let turn;
    try {
      turn = await client.submitTurn({ threadId, text: value, whileRunning: 'steer', idempotencyKey: `chat:${threadId}:${crypto.randomUUID()}`,
        ...(attached.length ? { images: attached.map(({ mimeType, data }) => ({ mimeType, data })) } : {}) });
    } catch (cause) {
      if (suppliedText === undefined) setText(value);
      if (attached.length) setImages((current) => [...attached, ...current]);
      setError(wording.sendFailed(cause.message));
      setTurns((current) => current.filter((item) => item.turnId !== optimistic.turnId));
      setSubmitting(false);
      return;
    }
    setEditing(null);
    // The sent images show from the composer's copies until the thread's next page brings the product's.
    setTurns((current) => current.map((item) => item.turnId === optimistic.turnId ? { ...turn, input: value, ...withImages } : item));
    setThreads((current) => current.map((thread) => thread.threadId === threadId
      ? {
        ...thread,
        title: thread.title || value.replace(/\s+/g, " ").slice(0, 60),
        latestTurnStatus: turn.status,
        latestTurnUpdatedAt: turn.updatedAt
      }
      : thread));
    setSubmitting(false);
  }

  function editMessage(turn) {
    if (busy || readOnly) return;
    setEditing({ turnId: turn.turnId, draft: editing?.draft ?? text });
    setText(turn.input || '');
    focusInput();
  }

  async function retryTurn(turn) {
    if (busy || readOnly || !canRetryTurn(turn, latestTurnId)) return;
    const targetThread = threadId;
    const key = retryKeys.current.get(turn.turnId) || `retry:${turn.turnId}:${crypto.randomUUID()}`;
    retryKeys.current.set(turn.turnId, key);
    setSubmitting(true); setError('');
    try {
      const retried = await client.retryTurn(turn.turnId, key);
      retryKeys.current.delete(turn.turnId);
      if (selectedThreadRef.current !== targetThread) return;
      setTurns(current => current.map(item => item.turnId === turn.turnId ? { ...item, ...retried } : item));
      setThreads(current => current.map(item => item.threadId === targetThread ? { ...item, latestTurnStatus: retried.status } : item));
    } catch (cause) {
      if (selectedThreadRef.current === targetThread) setError(wording.retryFailed(cause.message));
    } finally { setSubmitting(false); }
  }

  async function stopTurn(turn) {
    if (stopping || !canStopTurn(turn)) return;
    const targetThread = threadId;
    setStopping(turn.turnId); setError('');
    try {
      const stopped = await client.stopTurn(turn.turnId);
      if (selectedThreadRef.current !== targetThread) return;
      setTurns(current => current.map(item => item.turnId === turn.turnId ? { ...item, ...stopped } : item));
      setThreads(current => current.map(item => item.threadId === targetThread ? { ...item, latestTurnStatus: stopped.status } : item));
    } catch (cause) {
      if (selectedThreadRef.current === targetThread) setError(wording.stopFailed(cause.message));
    } finally { setStopping(null); }
  }

  async function createThread(permissions) {
    try {
      return await client.createThread({ idempotencyKey: `create-chat:${account.accountId}:${crypto.randomUUID()}`, ...(permissions ? { permissions } : {}) });
    } catch { return null; }
  }

  async function restoreChatState() {
    const saved = await client.loadSelectedThread?.() ?? null;
    const threads = await client.listThreads({ limit: THREAD_LIST_LIMIT });
    let selected = threads.find((thread) => thread.threadId === saved && listed(thread)) || threads.find(listed);
    if (!selected) selected = await createThread();
    if (!selected) throw new Error(wording.createFailed);
    await client.saveSelectedThread?.(selected.threadId);
    return { threadId: selected.threadId, threads: threads.some((thread) => thread.threadId === selected.threadId) ? threads : [selected, ...threads] };
  }

  async function startNewChat(permissions) {
    setEditing(null);
    const next = await createThread(permissions);
    if (!next) return setError(wording.createFailed);
    await client.saveSelectedThread?.(next.threadId);
    turnsRevisionRef.current = "";
    setThreadId(next.threadId);
    setThreads((current) => [next, ...current.filter((thread) => thread.threadId !== next.threadId)]);
    setTurns([]);
    setError("");
    setThreadMenuOpen(false);
  }

  async function selectThread(nextThreadId) {
    if (nextThreadId === threadId) return setThreadMenuOpen(false);
    await client.saveSelectedThread?.(nextThreadId);
    setEditing(null);
    turnsRevisionRef.current = "";
    stickToBottomRef.current = true;
    setThreadId(nextThreadId);
    setTurns([]);
    setError("");
    setThreadMenuOpen(false);
  }

  async function deleteChat(thread) {
    if (deletingThreadId) return;
    if (!window.confirm(wording.deleteConfirm(threadTitle(thread, wording)))) return;
    setDeletingThreadId(thread.threadId);
    setError("");
    try {
      await client.deleteThread(thread.threadId);
      deletedThreadIds.current.add(thread.threadId);
      setThreads(current => current.filter(item => item.threadId !== thread.threadId));
      if (selectedThreadRef.current === thread.threadId) {
        turnsRevisionRef.current = "";
        setTurns([]);
        setThreadId(null);
        await client.saveSelectedThread?.(null);
        const next = threads.find(item => listed(item) && !deletedThreadIds.current.has(item.threadId));
        if (next) await selectThread(next.threadId);
        else await startNewChat(thread.permissions);
      }
    } catch (cause) {
      setError(wording.deleteFailed(cause.message));
    } finally { setDeletingThreadId(null); }
  }

  // What a product's slots may read and do.
  const context = {
    account, thread: activeThread, threads, threadId, turns: visibleTurns, busy, readOnly, compose,
    openThread: (id) => selectThread(id),
    updateThread: (next) => setThreads((current) => current.map((thread) => thread.threadId === next.threadId ? next : thread)),
    addTurn: (turn) => setTurns((current) => [...current.filter((item) => item.turnId !== turn.turnId), turn])
  };

  if (!threadId) return initializing ? <ChatLoading /> : <div className="chat-error" role="alert"><p>{error || wording.noChat}</p><button type="button" onClick={() => startNewChat()}>{wording.newChat}</button></div>;

  return <div className="chat-view">
    {threadMenuOpen && menu?.root && createPortal(
      <ThreadMenu threads={threads} activeThreadId={threadId} onSelect={selectThread} onCreate={() => startNewChat()}
        onDelete={client.deleteThread ? deleteChat : undefined} deletingThreadId={deletingThreadId} />,
      menu.root
    )}
    {view.banner && <div className="chat-banner">{view.banner}</div>}
    <div ref={messagesRef} className="chat-messages" aria-live="polite" onScroll={trackMessageScroll}>
      {history.threadId === threadId && history.nextBefore && <button type="button" className="chat-state"
        onClick={loadOlderTurns} disabled={history.loading}>{history.loading ? wording.loadingEarlier : wording.loadEarlier}</button>}
      {!visibleTurns.length && !readOnly && (slots.welcome ? slots.welcome(context) : <p className="chat-welcome">{wording.welcome}</p>)}
      {groupTurns(visibleTurns).map((group) => <TurnGroup key={`${threadId}:${group.id}`} turns={group.turns} steers={group.steers}
        onCancel={stopTurn}
        onContinue={!readOnly ? () => submit({ preventDefault() {} }, wording.carryOnText) : undefined}
        onEdit={!readOnly ? editMessage : undefined} onRetry={!readOnly ? retryTurn : undefined}
        retryTurnId={latestTurnId} disabled={busy} />)}
      {view.notice}
      {busy && <div className="chat-state">{wording.working}</div>}
      {view.stop && stoppableTurn && <button type="button" className="chat-turn-retry" disabled={Boolean(stopping)} onClick={() => stopTurn(stoppableTurn)}>{view.stop}</button>}
      {error && <div className="chat-state is-error">{error}</div>}
      <div ref={endRef} />
    </div>
    {slots.tray?.(context)}
    {editing && <div className="chat-edit-notice">{wording.editNotice}
      <button type="button" onClick={() => { setText(editing.draft); setEditing(null); }}>{wording.cancelEdit}</button>
    </div>}
    {slots.controls?.(context)}
    {!readOnly && imageNotice && <div className="chat-edit-notice" role="status">{imageNotice}
      <button type="button" onClick={() => setImageNotice("")}>{wording.dismiss}</button>
    </div>}
    {!readOnly && <Composer text={text} onText={setText} onSubmit={submit} inputRef={inputRef}
      settings={slots.settings?.(context)} stoppable={Boolean(stoppableTurn)} stopping={Boolean(stopping)} onStop={() => stopTurn(stoppableTurn)}
      images={images} onImages={slots.images ? attachImages : undefined} onRemoveImage={removeImage}
      sendDisabled={!(text.trim() || images.length) || preparing > 0 || submitting || Boolean(stopping)} />}
  </div>;
}

function ChatLoading() {
  const { wording } = useChatConfig();
  return <div className="chat-loading" role="status"><span></span><p>{wording.connecting}</p></div>;
}
