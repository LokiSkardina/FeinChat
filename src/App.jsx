import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUp, Check, Copy, Ellipsis, Moon, Pencil, Pin, PinOff, Plus, RotateCcw, Settings as SettingsIcon,
  SlidersHorizontal, Square, Sun, Trash2, X,
} from 'lucide-react';
import mark from '../assets/feinchat-mark.png?no-inline';
import { MarkdownMessage } from './MarkdownMessage.jsx';
import { ChatSettings, Settings } from './Settings.jsx';
import './styles.css';

const api = window.feinchat;
const MAX_TEXT = 1_000_000;
const messageStates = {
  streaming: 'Generating…',
  stopped: 'Stopped',
  failed: 'Response failed',
  interrupted: 'Response interrupted when the app closed',
};

export function Modal({ label, close, children, wide = false }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog ref={ref} aria-label={label} className={wide ? 'wide' : ''} onCancel={(event) => {
      event.preventDefault();
      close();
    }}>
      {children}
    </dialog>
  );
}

function ActionDialog({ action, close, busy }) {
  const [value, setValue] = useState(action.value ?? '');
  const [error, setError] = useState('');
  const ConfirmIcon = action.icon ?? Check;
  async function submit(event) {
    event.preventDefault();
    if (action.field && (!value.trim() || value === action.value)) return;
    const reply = await action.submit(value);
    if (reply.ok) close();
    else setError(reply.error);
  }
  return (
    <Modal label={action.title} close={() => { if (!busy) close(); }}>
      <form className="dialog-content" onSubmit={submit}>
        <h2>{action.title}</h2>
        {action.description && <p>{action.description}</p>}
        {action.field === 'name' && (
          <input autoFocus aria-label="Chat name" required maxLength={120}
            value={value} onChange={(event) => setValue(event.target.value)} />
        )}
        {action.field === 'message' && (
          <textarea autoFocus aria-label="Message text" rows={8} required maxLength={MAX_TEXT}
            value={value} onChange={(event) => setValue(event.target.value)} />
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={close} disabled={busy} autoFocus={!action.field}><X />Cancel</button>
          <button type="submit" className={action.danger ? 'danger' : 'primary'}
            disabled={busy || (action.field && (!value.trim() || value === action.value))}>
            <ConfirmIcon />{action.label}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ChatRow({ chat, selected, running, busy, choose, pin, rename, remove, parameters }) {
  const menuRef = useRef(null);
  const menuId = `chat-actions-${chat.id}`;
  const label = `Chat actions: ${chat.name}`;
  const action = (callback) => {
    menuRef.current.hidePopover();
    callback(chat);
  };
  return (
    <div className={`chat-row${selected ? ' selected' : ''}`}>
      <button className="chat-name" title={chat.name} aria-current={selected ? 'page' : undefined}
        disabled={busy} onClick={() => choose(chat.id)}>
        {chat.pinned === 1 && <span className="pin-mark" title="Pinned" aria-label="Pinned"><Pin /></span>}
        <span className="chat-title">{chat.name}</span>
        {running && <span className="running-dot" title="Generating" />}
      </button>
      <button className="icon-button chat-menu" aria-label={label} title={label} popoverTarget={menuId}>
        <Ellipsis />
      </button>
      <div className="chat-actions" popover="auto" id={menuId} ref={menuRef} role="group" aria-label={label}
        onToggle={(event) => {
          if (event.currentTarget.matches(':popover-open')) {
            event.currentTarget.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
          }
        }}>
        <button disabled={busy} onClick={() => action(parameters)}><SlidersHorizontal />Chat settings</button>
        <button disabled={busy} onClick={() => action(pin)}>
          {chat.pinned ? <PinOff /> : <Pin />}{chat.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button disabled={busy} onClick={() => action(rename)}><Pencil />Rename</button>
        <button className="menu-danger" disabled={busy || running} onClick={() => action(remove)}><Trash2 />Delete</button>
      </div>
    </div>
  );
}

function Sidebar({
  chats, selectedId, running, busy, choose, create, pin, rename, remove, parameters, openSettings, theme, toggleTheme,
}) {
  const themeLabel = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand-row">
          <div className="brand"><img src={mark} alt="" />FeinChat</div>
          <div className="sidebar-tools">
            <button className="icon-button theme-button" type="button" aria-label={themeLabel} title={themeLabel}
              disabled={busy} onClick={toggleTheme}>{theme === 'dark' ? <Sun /> : <Moon />}</button>
            <button className="icon-button settings-button" type="button" aria-label="Settings" title="Settings"
              disabled={busy} onClick={openSettings}><SettingsIcon /></button>
          </div>
        </div>
        <button className="new-chat" disabled={busy} onClick={create}><Plus />New chat</button>
      </div>
      {chats.length > 0 && <div className="sidebar-caption">Chats</div>}
      <nav className="chats" aria-label="Chats"
        onScroll={(event) => event.currentTarget.querySelector('.chat-actions:popover-open')?.hidePopover()}>
        {chats.map((chat) => (
          <ChatRow key={chat.id} chat={chat} selected={chat.id === selectedId} running={running?.chatId === chat.id}
            busy={busy} choose={choose} pin={pin} rename={rename} remove={remove} parameters={parameters} />
        ))}
      </nav>
    </aside>
  );
}

function Messages({ chat, running, busy, edit, remove, regenerate, copy, copied, copyText, openLink }) {
  const ref = useRef(null);
  const atBottom = useRef(true);
  const previousChat = useRef(null);
  useLayoutEffect(() => {
    const scroller = ref.current;
    if (chat?.id !== previousChat.current) {
      atBottom.current = true;
      previousChat.current = chat?.id;
    }
    if (atBottom.current) scroller.scrollTop = scroller.scrollHeight;
  }, [chat?.id, chat?.messages]);

  return (
    <div className={`history${chat?.messages.length ? '' : ' history-empty'}`} ref={ref} onScroll={(event) => {
      const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
      atBottom.current = scrollHeight - scrollTop - clientHeight < 75;
    }}>
      {!chat?.messages.length && (
        <div className="empty">
          <img src={mark} alt="" />
          <p>{chat ? 'Messages will appear here.' : 'Create a chat to get started.'}</p>
        </div>
      )}
      {Boolean(chat?.messages.length) && (
        <div className="message-list">
          {chat.messages.map((message) => {
            const isCopied = copied?.id === message.id && copied.text === message.text;
            const copyLabel = isCopied ? 'Copied' : 'Copy';
            return (
              <article className={`message ${message.role}`} key={message.id}
                aria-label={message.role === 'user' ? 'Your message' : 'Assistant response'}>
                {message.role === 'assistant' && <div className="message-role" aria-hidden="true">Assistant</div>}
                {message.text && (
                  <div className="message-text">
                    <MarkdownMessage text={message.text} copy={copyText} openLink={openLink} />
                  </div>
                )}
                {messageStates[message.status] && (message.status !== 'streaming' || !message.text) && (
                  <div className="message-status">{messageStates[message.status]}</div>
                )}
                {message.error && (
                  <div className={message.status === 'failed' ? 'message-error' : 'message-status'}>{message.error}</div>
                )}
                <div className="message-actions">
                  <button className={`icon-button${isCopied ? ' copied' : ''}`}
                    aria-label={copyLabel} title={copyLabel} disabled={!message.text} onClick={() => copy(message)}>
                    {isCopied ? <Check /> : <Copy />}
                  </button>
                  <button className="icon-button" aria-label="Edit" title="Edit"
                    disabled={busy || running?.chatId === chat.id || (message.role === 'user' && Boolean(running))}
                    onClick={() => edit(message)}><Pencil /></button>
                  {message.role === 'assistant' && (
                    <button className="icon-button" aria-label="Regenerate" title="Regenerate"
                      disabled={busy || Boolean(running)} onClick={() => regenerate(message)}><RotateCcw /></button>
                  )}
                  <button className="icon-button" aria-label="Delete" title="Delete"
                    disabled={busy || running?.chatId === chat.id} onClick={() => remove(message)}><Trash2 /></button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function mergeGeneration(state, event) {
  if (!state || !event || state.revision >= event.revision) return state;
  let chat = state.chat;
  if (chat?.id === event.message.chatId && chat.messages.some((item) => item.id === event.message.id)) {
    chat = { ...chat, messages: chat.messages.map((item) => item.id === event.message.id ? event.message : item) };
  }
  return { ...state, chat, revision: event.revision, running: event.running };
}

function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(null);
  const [chatSettings, setChatSettings] = useState(null);
  const [action, setAction] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [copied, setCopied] = useState(null);
  const pending = useRef(false);
  const issued = useRef(0);
  const received = useRef(0);
  const latestEvent = useRef(null);

  const invoke = useCallback(async (operation) => {
    const seq = ++issued.current;
    try {
      const reply = await operation();
      if (reply.state && seq >= received.current) {
        received.current = seq;
        setState(mergeGeneration(reply.state, latestEvent.current));
      }
      return reply;
    } catch {
      return { ok: false, error: 'Connection to the FeinChat main process was lost.' };
    }
  }, []);

  const copyText = useCallback(async (content) => {
    const reply = await invoke(() => api.copy(content));
    if (!reply.ok) setError(reply.error);
    return reply;
  }, [invoke]);
  const openLink = useCallback(async (url) => {
    const reply = await invoke(() => api.openLink(url));
    if (!reply.ok) setError(reply.error);
  }, [invoke]);

  useEffect(() => {
    let mounted = true;
    async function refresh() {
      const reply = await invoke(api.read);
      if (mounted && !reply.ok) setError(reply.error);
    }
    const off = api.onGeneration((event) => {
      latestEvent.current = event;
      setState((previous) => mergeGeneration(previous, event));
      if (!event.running) void refresh();
    });
    void refresh();
    return () => { mounted = false; off(); };
  }, [invoke]);

  useLayoutEffect(() => {
    if (state?.theme) document.documentElement.dataset.theme = state.theme;
  }, [state?.theme]);

  async function command(operation, showError = true) {
    if (pending.current) return { ok: false, error: 'Wait for the previous operation to finish.' };
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const reply = await invoke(operation);
      if (!reply.ok && showError) setError(reply.error);
      return reply;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const chat = state?.chat;
  const running = state?.running;
  const last = chat?.messages.at(-1);
  const draft = drafts[chat?.id] ?? '';
  const retryEmptyAnswer = last?.role === 'assistant' && last.text === '' &&
    ['failed', 'stopped', 'interrupted'].includes(last.status) && chat.messages.at(-2)?.role === 'user';
  const canReply = last?.role === 'user' || retryEmptyAnswer;
  const hasDraft = Boolean(draft.trim());
  const sendLabel = !hasDraft && canReply ? 'Get response' : 'Send';
  const configured = state?.providers.find((provider) => provider.id === chat?.providerId);
  const details = chatSettings && (chatSettings.id === chat?.id ? chat : chatSettings);
  const inactiveChatId = details?.id === chat?.id ? null : details?.id;
  const stop = () => command(() => api.stop(running.chatId, running.messageId));
  const changeDraft = (value) => setDrafts((previous) => ({ ...previous, [chat.id]: value }));

  useEffect(() => {
    const event = latestEvent.current;
    if (!inactiveChatId || event?.message.chatId !== inactiveChatId || event.running) return;
    void invoke(() => api.readChat(inactiveChatId)).then((reply) => {
      if (reply.ok) setChatSettings((current) => current?.id === inactiveChatId ? reply.chat : current);
    });
  }, [inactiveChatId, state?.revision, invoke]);

  function createChat() {
    if (state.providers.length === 0) setSettings('first-chat');
    else void command(api.createChat);
  }

  async function openChatSettings(target) {
    if (target.id === chat?.id) {
      setChatSettings(chat);
      return;
    }
    const reply = await command(() => api.readChat(target.id));
    if (reply.ok) setChatSettings(reply.chat);
  }

  async function saveChatSettings(operation, showError) {
    const reply = await command(operation, showError);
    if (reply.ok && chatSettings.id !== chat?.id) {
      const updated = await invoke(() => api.readChat(chatSettings.id));
      if (updated.ok) setChatSettings((current) => current?.id === updated.chat.id ? updated.chat : current);
    }
    return reply;
  }

  async function send(event) {
    event?.preventDefault();
    if (!chat || running || busy || (!hasDraft && !canReply)) return;
    const args = { chatId: chat.id, lastId: last?.id ?? null };
    if (hasDraft) {
      Object.assign(args, { mode: 'send', content: draft });
    } else if (retryEmptyAnswer) {
      Object.assign(args, { mode: 'regenerate', messageId: last.id, confirmed: false });
    } else {
      args.mode = 'reply';
    }
    const reply = await command(() => api.start(args));
    if (reply.ok && hasDraft) {
      setDrafts((previous) => previous[chat.id] === draft ? { ...previous, [chat.id]: '' } : previous);
    }
  }

  function changeMessage(message, mode) {
    const later = last.id !== message.id;
    const historyWarning = 'All messages after the selected message will be permanently deleted.';
    const args = { chatId: chat.id, messageId: message.id, lastId: last.id };
    if (mode === 'edit') {
      const label = message.role === 'user' ? 'Save and get response' :
        later ? 'Save and delete later messages' : 'Save';
      setAction({
        title: 'Edit message', field: 'message', value: message.text,
        label,
        description: later ? historyWarning : null, danger: later,
        submit: (value) => command(() => api.editMessage({ ...args, content: value, confirmed: later }), false),
      });
    } else if (mode === 'delete') {
      setAction({
        title: 'Delete message?', label: 'Delete', danger: true, icon: Trash2,
        description: later ? historyWarning : 'This message will be permanently deleted.',
        submit: () => command(() => api.deleteMessage({ ...args, confirmed: later }), false),
      });
    } else {
      const retry = (showError) => command(() => api.start({ ...args, mode: 'regenerate', confirmed: later }), showError);
      if (later) {
        setAction({
          title: 'Regenerate response?', label: 'Delete and regenerate', danger: true, icon: RotateCcw,
          description: historyWarning,
          submit: () => retry(false),
        });
      } else {
        void retry(true);
      }
    }
  }

  function rename(target) {
    setAction({
      title: 'Rename chat', field: 'name', value: target.name, label: 'Save',
      submit: (name) => command(() => api.renameChat(target.id, name), false),
    });
  }

  function removeChat(target) {
    setAction({
      title: 'Delete chat?', label: 'Delete', danger: true, icon: Trash2,
      description: `The chat “${target.name}” and its history will be permanently deleted.`,
      submit: () => command(() => api.deleteChat(target.id, true), false),
    });
  }

  const needsKey = chat && !configured?.hasKey;
  const needsChatSettings = chat && (configured?.baseUrl !== chat.baseUrl || !chat.model);

  return (
    <div className="app-shell">
      <Sidebar chats={state?.chats ?? []} selectedId={chat?.id} running={running} busy={busy || !state}
        openSettings={() => setSettings('connections')} theme={state?.theme}
        toggleTheme={() => command(() => api.setTheme(state.theme === 'dark' ? 'light' : 'dark'))}
        choose={(id) => command(() => api.selectChat(id))} create={createChat} parameters={openChatSettings}
        pin={(target) => command(() => api.pinChat(target.id, !target.pinned))} rename={rename} remove={removeChat} />
      <main>
        <header className="topbar">
          <h1 title={chat?.name}>{chat?.name ?? 'Chats'}</h1>
          {chat && (
            <button className="model" type="button" aria-label="Current chat settings" disabled={busy}
              title={`${chat.providerName} · ${chat.model || 'No model selected'} · ${new URL(chat.baseUrl).host}`}
              onClick={() => openChatSettings(chat)}>
              <SlidersHorizontal /><span>{chat.model || chat.providerName}</span>
            </button>
          )}
        </header>
        <div className="chat-workspace">
          {!state && !error ? (
            <div className="history history-empty"><div className="empty" role="status">Loading…</div></div>
          ) : (
            <Messages chat={chat} running={running} busy={busy} copied={copied} copyText={copyText} openLink={openLink}
              edit={(message) => changeMessage(message, 'edit')} remove={(message) => changeMessage(message, 'delete')}
              regenerate={(message) => changeMessage(message, 'regenerate')}
              copy={async (message) => {
                const reply = await copyText(message.text);
                if (reply.ok) setCopied({ id: message.id, text: message.text });
              }} />
          )}
          {(chat || running || error) && (
            <div className="composer">
              {error && <p className="error" role="alert">{error}</p>}
              {needsKey ? (
                <p className="composer-hint">
                  An API key is required to send messages.{' '}
                  <button className="text-button" onClick={() => setSettings('connections')}>Connections</button>
                </p>
              ) : needsChatSettings && (
                <p className="composer-hint">
                  {configured.baseUrl !== chat.baseUrl ? 'The connection URL has changed.' : 'Select a model to send messages.'}{' '}
                  <button className="text-button" onClick={() => openChatSettings(chat)}>Chat settings</button>
                </p>
              )}
              {running && running.chatId !== chat?.id && (
                <p className="composer-hint" role="status">A response is being generated in another chat.</p>
              )}
              <form onSubmit={send} className="compose-row">
                <textarea rows={1} key={chat?.id ?? 'empty'} placeholder="Write a message"
                  aria-label="Message" disabled={!chat} maxLength={MAX_TEXT}
                  value={draft} onChange={(event) => changeDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      if (!event.repeat) void send();
                    }
                  }} />
                {running ? (
                  <button className="stop icon-button" type="button" aria-label="Stop" title="Stop"
                    onClick={stop} disabled={busy}><Square /></button>
                ) : (
                  <button className="send icon-button primary" type="submit" title={sendLabel} aria-label={sendLabel}
                    disabled={busy || (!hasDraft && !canReply)}><ArrowUp /></button>
                )}
              </form>
            </div>
          )}
        </div>
      </main>
      {settings && (
        <Settings state={state} busy={busy} command={command} close={() => setSettings(null)} Modal={Modal} api={api}
          startAdding={settings === 'first-chat'} onFirstConnection={settings === 'first-chat' ? async () => {
            const reply = await command(api.createChat);
            if (reply.ok) setSettings(null);
          } : undefined} />
      )}
      {details && (
        <ChatSettings chat={details} providers={state.providers} running={running} busy={busy} command={saveChatSettings}
          close={() => setChatSettings(null)} Modal={Modal} api={api} openConnections={() => {
            setChatSettings(null);
            setSettings('connections');
          }} />
      )}
      {action && <ActionDialog action={action} busy={busy} close={() => setAction(null)} />}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
