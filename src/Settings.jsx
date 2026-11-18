import React, { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Pencil, Plug2, Plus, X } from 'lucide-react';
import { providerCatalog } from './provider-catalog.mjs';

const tokens = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 });

function hostOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.host : '';
  } catch {
    return '';
  }
}

function makeForm(provider) {
  return {
    name: provider?.name ?? '',
    baseUrl: provider?.baseUrl ?? '',
    apiKey: '',
    clearKey: false,
    model: provider?.model ?? '',
    temperature: provider?.temperature ?? '',
    maxTokens: provider?.maxTokens ?? '',
  };
}

function ProviderForm({ provider, preset, busy, save }) {
  const [form, setForm] = useState(() => makeForm(provider ?? preset));
  const [error, setError] = useState('');
  const change = ({ target }) => {
    setError('');
    setForm((previous) => ({
      ...previous,
      [target.name]: target.type === 'checkbox' ? target.checked : target.value,
      ...(target.name === 'baseUrl' && { clearKey: false }),
    }));
  };
  const host = hostOf(form.baseUrl);
  const changedHost = Boolean(provider?.hasKey && host && host !== hostOf(provider.baseUrl));
  async function submit(event) {
    event.preventDefault();
    const optional = (key) => form[key] === '' ? null : Number(form[key]);
    const reply = await save({
      ...form, id: provider?.id ?? null, temperature: optional('temperature'), maxTokens: optional('maxTokens'),
    });
    if (!reply.ok) setError(reply.error);
  }
  return (
    <form onSubmit={submit} className="provider-form">
      <label>Connection name
        <input name="name" autoComplete="off" required maxLength={100} value={form.name} onChange={change} />
      </label>
      <label>HTTPS Base URL
        <input name="baseUrl" type="url" autoComplete="off" required maxLength={2048}
          placeholder="https://provider.example/v1" value={form.baseUrl} onChange={change} />
      </label>
      {host && <p className="form-note"><b>Receives your key and messages</b> <span className="copyable">{host}</span></p>}
      {changedHost && <p className="form-note">Changing the host removes the saved key. Enter a key for the new host.</p>}
      <label>API key
        <input name="apiKey" type="password" autoComplete="new-password" maxLength={4096}
          disabled={form.clearKey} required={!provider} value={form.apiKey} onChange={change}
          placeholder={provider?.hasKey && !changedHost ? '•••••••• (saved)' : 'Enter API key'} />
      </label>
      {provider?.hasKey === 1 && !changedHost && (
        <label className="check-label">
          <input type="checkbox" name="clearKey" checked={form.clearKey} disabled={Boolean(form.apiKey)} onChange={change} />
          Remove saved key
        </label>
      )}
      <label>Default model ID
        <input name="model" autoComplete="off" required={!provider} maxLength={256} value={form.model} onChange={change} />
      </label>
      <div className="number-fields">
        <label>Temperature
          <input type="number" min="0" max="2" step="any" name="temperature" placeholder="API default"
            value={form.temperature} onChange={change} />
        </label>
        <label>Max output tokens
          <input type="number" min="1" max="2147483647" name="maxTokens" placeholder="API default"
            value={form.maxTokens} onChange={change} />
        </label>
      </div>
      <div className="settings-actions">
        <button type="submit" className="primary" disabled={busy}><Check />Save connection</button>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </form>
  );
}

function SettingsHeading({ title, busy, close, back, headingRef }) {
  return (
    <div className="dialog-heading settings-heading">
      <div className="settings-title">
        {back && (
          <button type="button" className="icon-button settings-back" aria-label="Back" title="Back"
            disabled={busy} onClick={back}><ArrowLeft /></button>
        )}
        <h2 ref={headingRef} tabIndex={headingRef ? -1 : undefined}>{title}</h2>
      </div>
      <button type="button" className="icon-button" aria-label="Close settings" title="Close settings"
        disabled={busy} onClick={close}><X /></button>
    </div>
  );
}

function Connections({ providers, defaultId, busy, add, edit, setDefault }) {
  const keyed = providers.filter((provider) => provider.hasKey).length;
  return (
    <section className="settings-section">
      <div className="section-heading">
        <h3>Connections</h3>
        <button type="button" className="primary" onClick={add} disabled={busy}><Plus />Add connection</button>
      </div>
      {providers.length === 0 ? <p className="form-note">No connections yet.</p> : (
        <ul className="connection-list">
          {providers.map((provider) => (
            <li className="connection-row" key={provider.id} data-connection-id={provider.id}>
              <button type="button" className="connection-edit" onClick={() => edit(provider.id)}
                aria-label={`Edit connection: ${provider.name}`} disabled={busy}>
                <span className="provider-symbol" aria-hidden="true"><Plug2 /></span>
                <span className="connection-details">
                  <strong className="connection-name" title={provider.name}>{provider.name}</strong>
                  <span className="connection-model" title={provider.model}>
                    {provider.model || 'No model selected'}
                  </span>
                  {!provider.hasKey && <span className="connection-warning">No API key</span>}
                </span>
                <Pencil className="connection-pencil" aria-hidden="true" />
              </button>
              {provider.hasKey === 1 && provider.id === defaultId && <span className="connection-default">Default</span>}
              {keyed > 1 && provider.hasKey && provider.id !== defaultId && (
                <button type="button" className="connection-default text-button" onClick={() => setDefault(provider.id)}
                  aria-label={`Set ${provider.name} as default`} disabled={busy}>Set as default</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Settings({ state, busy, command, close, Modal, api, startAdding = false, onFirstConnection }) {
  const { providers, selected } = state;
  const [view, setView] = useState(() => ({ page: startAdding ? 'catalog' : 'list' }));
  const [notice, setNotice] = useState(null);
  const body = useRef(null);
  const heading = useRef(null);
  const provider = providers.find(({ id }) => id === view.providerId);
  const titles = { list: 'Settings', catalog: 'Provider catalog', create: 'New connection', edit: 'Edit connection' };
  const title = titles[view.page];

  useLayoutEffect(() => {
    body.current.scrollTop = 0;
    heading.current.focus({ preventScroll: true });
  }, [view]);

  function show(next) {
    setNotice(null);
    setView(next);
  }

  async function saveProvider(form) {
    const reply = await command(() => api.saveProvider(form), false);
    if (reply.ok) {
      setView({ page: 'list' });
      setNotice({ text: 'Connection saved.' });
      if (form.id === null && providers.length === 0) await onFirstConnection?.();
    }
    return reply;
  }

  async function setDefault(providerId) {
    const reply = await command(() => api.setDefaultProvider(providerId), false);
    setNotice(reply.ok ? { text: 'Default connection updated.' } : { error: true, text: reply.error });
  }

  return (
    <Modal label="Settings" close={() => { if (!busy) close(); }} wide>
      <SettingsHeading title={title} busy={busy} close={close} headingRef={heading}
        back={view.page === 'list' ? null : () => show({ page: view.page === 'create' ? 'catalog' : 'list' })} />
      <div className="settings-body" ref={body}>
        {view.page === 'list' && (
          <Connections providers={providers} defaultId={selected.providerId} busy={busy}
            add={() => show({ page: 'catalog' })} edit={(providerId) => show({ page: 'edit', providerId })} setDefault={setDefault} />
        )}
        {view.page === 'catalog' && (
          <div className="settings-section">
            <div className="provider-catalog">
              {providerCatalog.map((preset) => (
                <button type="button" className="provider-card" key={preset.name} data-provider={preset.name}
                  aria-label={preset.name} disabled={busy} onClick={() => show({ page: 'create', preset })}>
                  <span className="provider-symbol" aria-hidden="true"><Plug2 /></span>
                  <span className="provider-card-label">
                    <strong>{preset.name}</strong><small>{hostOf(preset.baseUrl)}</small>
                  </span>
                </button>
              ))}
              <button type="button" className="provider-card" data-provider="custom" disabled={busy}
                onClick={() => show({ page: 'create' })}>
                <span className="provider-symbol" aria-hidden="true"><Plus /></span><strong>Custom provider</strong>
              </button>
            </div>
          </div>
        )}
        {(view.page === 'create' || view.page === 'edit') && (
          <div className="settings-section">
            <ProviderForm key={view.page} provider={provider} preset={view.preset} busy={busy} save={saveProvider} />
          </div>
        )}
        {notice && (
          <div className="settings-section">
            <p className={notice.error ? 'error' : 'form-note'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function usageValue(value, known, count, format) {
  if (!known) return null;
  return format(value) + (known < count ? ' (partial)' : '');
}

function ChatUsage({ usage }) {
  const items = [
    ['Input tokens', usageValue(usage.inputTokens, usage.inputKnown, usage.requests, tokens.format)],
    ['Output tokens', usageValue(usage.outputTokens, usage.outputKnown, usage.requests, tokens.format)],
    ['Total tokens', usageValue(usage.totalTokens, usage.totalKnown, usage.requests, tokens.format)],
    ['Total cost', usageValue(usage.costs, usage.costKnown, usage.requests, (costs) => costs.map((cost) =>
      money.format(cost.amount) + ' ' + (cost.currency ?? `(currency not specified, ${cost.host})`)).join(' + '))],
  ];
  return (
    <section className="settings-section">
      <h3>Usage</h3>
      <dl className="chat-usage"
        title="Usage across all requests in this chat, including regenerations. Partial totals include only reported data.">
        {items.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="chat-usage-value">{value ?? 'Not available'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ChatSettings({ chat, providers, running, busy, command, close, Modal, api, openConnections }) {
  const [providerId, setProviderId] = useState(chat.providerId);
  const [model, setModel] = useState(chat.model ?? '');
  const [temperature, setTemperature] = useState(chat.temperatureOverride ?? '');
  const [maxTokens, setMaxTokens] = useState(chat.maxTokensOverride ?? '');
  const [notice, setNotice] = useState(null);
  const target = providers.find(({ id }) => id === providerId);
  const generating = running?.chatId === chat.id;

  async function apply(event) {
    event.preventDefault();
    const parameters = {
      temperature: temperature === '' ? null : Number(temperature),
      maxTokens: maxTokens === '' ? null : Number(maxTokens),
    };
    const reply = await command(() => api.applyModel(chat.id, providerId, model, parameters), false);
    setNotice(reply.ok ? { text: 'Chat settings saved.' } : { error: true, text: reply.error });
  }

  return (
    <Modal label="Chat settings" close={() => { if (!busy) close(); }}>
      <SettingsHeading title="Chat settings" busy={busy} close={close} />
      <div className="settings-body">
        <form className="settings-section chat-settings-form" onSubmit={apply}>
          <h3 className="chat-settings-name" title={chat.name}>{chat.name}</h3>
          {providers.length > 1 ? (
            <label>API connection
              <select value={providerId ?? ''} disabled={busy || generating}
                onChange={(event) => {
                  const id = Number(event.target.value);
                  setProviderId(id);
                  setModel(providers.find((provider) => provider.id === id).model);
                  setNotice(null);
                }}>
                {!target && <option value="" disabled>Select a connection</option>}
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <div className="chat-connection">
              <span>API connection</span><strong>{target?.name ?? 'No connection'}</strong>
            </div>
          )}
          <label>Chat model ID
            <input name="model" maxLength={256} required autoComplete="off" value={model} disabled={busy || generating}
              onChange={(event) => {
                setModel(event.target.value);
                setNotice(null);
              }} />
          </label>
          <div className="number-fields">
            <label>Temperature
              <input name="temperature" type="number" min="0" max="2" step="any"
                aria-describedby="chat-parameter-help"
                placeholder={target?.temperature == null ? 'API default' : String(target.temperature)}
                value={temperature} disabled={busy || generating} onChange={(event) => {
                  setTemperature(event.target.value);
                  setNotice(null);
                }} />
            </label>
            <label>Max output tokens
              <input name="maxTokens" type="number" min="1" max="2147483647"
                aria-describedby="chat-parameter-help"
                placeholder={target?.maxTokens == null ? 'API default' : String(target.maxTokens)}
                value={maxTokens} disabled={busy || generating} onChange={(event) => {
                  setMaxTokens(event.target.value);
                  setNotice(null);
                }} />
            </label>
          </div>
          <p className="form-note" id="chat-parameter-help">
            Leave blank to use the connection value. If that is also unset, the API default applies.
          </p>
          {!target?.hasKey && openConnections && (
            <p className="form-note">
              {target ? 'No API key.' : 'Add an API connection.'}{' '}
              <button className="text-button" type="button" onClick={openConnections} disabled={busy}>Connections</button>
            </p>
          )}
          <div className="settings-actions">
            <button type="submit" className="primary" disabled={busy || generating || !target || !model.trim()}>
              <Check />Apply to chat
            </button>
            {notice && <p className={notice.error ? 'error' : 'form-note'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
          </div>
        </form>
        <ChatUsage usage={chat.usage} />
      </div>
    </Modal>
  );
}
