const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { openStore } = require('../electron/store.cjs');
const { createGeneration } = require('../electron/generation.cjs');
const { chatCompletion } = require('../electron/api.cjs');
const { providerInput, generationParameters } = require('../electron/input.cjs');

const preset = {
  id: null, name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'fixture-key',
  clearKey: false, model: 'fixture/model', temperature: null, maxTokens: null,
};

function database() {
  const temporary = path.join(__dirname, '..', '.cache', 'tmp');
  mkdirSync(temporary, { recursive: true });
  return path.join(mkdtempSync(path.join(temporary, 'core-')), 'fixture.sqlite3');
}

test('a fresh database persists appearance before the first configured provider', () => {
  const filename = database();
  let db = openStore(filename);
  try {
    assert.equal(db.snapshot().theme, 'light');
    assert.deepEqual(db.snapshot().selected, { providerId: null, chatId: null });
    assert.throws(() => db.createChat(), /Add an API connection/);
    assert.throws(() => db.saveProvider(providerInput({ ...preset, apiKey: '' })), /API key/);
    assert.deepEqual(db.snapshot().providers, []);
    db.setTheme('dark');
  } finally {
    db.close();
  }

  db = openStore(filename);
  try {
    assert.equal(db.snapshot().theme, 'dark');
    const first = db.saveProvider(providerInput(preset));
    const second = db.saveProvider(providerInput({ ...preset, name: 'Другое подключение' }));
    assert.equal(db.snapshot().selected.providerId, first);
    db.setDefaultProvider(second);
    db.saveProvider(providerInput({ ...preset, name: 'Третье подключение' }));
    db.createChat();
    assert.equal(db.snapshot().chat.providerId, second);
    assert.equal(db.snapshot().chat.name, 'New chat');
  } finally {
    db.close();
  }
});

test('appearance migration preserves a version 1 chat, usage and legacy provider', () => {
  const filename = database();
  openStore(filename).close();
  const legacy = new DatabaseSync(filename);
  try {
    legacy.exec(`
      DROP TABLE appearance;
      ALTER TABLE chats DROP COLUMN temperatureOverride;
      ALTER TABLE chats DROP COLUMN maxTokensOverride;
      PRAGMA user_version = 1;
      INSERT INTO providers (id, name, baseUrl, apiKey, model) VALUES (1, 'Old OpenRouter', 'https://openrouter.ai/api/v1', '', '');
      INSERT INTO chats (id, name, updatedAt, providerId, baseUrl, model) VALUES
        (7, 'Existing chat', 0, 1, 'https://openrouter.ai/api/v1', 'old/model');
      INSERT INTO preferences (id, providerId, chatId) VALUES (1, 1, 7);
      INSERT INTO messages (id, chatId, role, text, status) VALUES (1, 7, 'user', 'Preserved text', 'done');
      INSERT INTO requests (chatId, endpoint, inputTokens, outputTokens, totalTokens, cost, currency)
        VALUES (7, 'openrouter.ai', 2, 3, 5, 0.2, 'USD');
    `);
  } finally {
    legacy.close();
  }

  const db = openStore(filename);
  try {
    assert.equal(db.theme(), 'light');
    assert.equal(db.provider(1).apiKey, '');
    assert.equal(db.snapshot().selected.chatId, 7);
    const before = db.snapshot().chat;
    assert.equal(before.name, 'Existing chat');
    assert.equal(before.model, 'old/model');
    assert.equal(before.messages[0].text, 'Preserved text');
    assert.equal(before.usage.totalTokens, 5);
    assert.equal(before.usage.costs[0].amount, 0.2);

    const first = db.saveProvider(providerInput(preset));
    assert.equal(db.snapshot().selected.providerId, first);
    assert.deepEqual(db.snapshot().chat, before);
    db.setDefaultProvider(1); // Reproduce a legacy database with a stale keyless default.
    assert.equal(db.snapshot().selected.providerId, first);
    db.saveProvider(providerInput({ ...preset, name: 'Другое подключение' }));
    assert.equal(db.snapshot().selected.providerId, first);
    db.createChat();
    assert.equal(db.snapshot().chat.providerId, first);
    const { messages, ...details } = before;
    assert.deepEqual(db.chatDetails(before.id), details);
  } finally {
    db.close();
  }
});

test('version 2 migration retains data and leaves chat generation values inherited', () => {
  const filename = database();
  const initial = openStore(filename);
  const providerId = initial.saveProvider(providerInput({ ...preset, temperature: 0.8, maxTokens: 4096 }));
  initial.createChat();
  const chat = initial.snapshot().chat;
  const job = initial.beginGeneration(chat, { mode: 'send', tailId: null, text: 'Original **Markdown**' });
  initial.finishGeneration({ ...job, text: 'Original answer', usage: {
    inputTokens: 11, outputTokens: 7, totalTokens: 18, cost: 0.04, currency: 'USD',
  } }, 'done', null);
  initial.close();

  const old = new DatabaseSync(filename);
  let rows;
  try {
    old.exec(`
      ALTER TABLE chats DROP COLUMN temperatureOverride;
      ALTER TABLE chats DROP COLUMN maxTokensOverride;
      PRAGMA user_version = 2;
    `);
    rows = {
      providers: old.prepare('SELECT * FROM providers').all(),
      chats: old.prepare('SELECT * FROM chats').all(),
      messages: old.prepare('SELECT * FROM messages').all(),
      requests: old.prepare('SELECT * FROM requests').all(),
    };
  } finally {
    old.close();
  }
  const db = openStore(filename);
  try {
    const migrated = db.snapshot().chat;
    assert.equal(migrated.temperatureOverride, null);
    assert.equal(migrated.maxTokensOverride, null);
    assert.equal(migrated.temperature, 0.8);
    assert.equal(migrated.maxTokens, 4096);
    assert.equal(migrated.model, chat.model);
    assert.equal(db.provider(providerId).apiKey, preset.apiKey);
    const actual = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(actual.prepare('PRAGMA user_version').get().user_version, 3);
      for (const table of ['providers', 'messages', 'requests']) {
        assert.deepEqual(actual.prepare('SELECT * FROM ' + table).all(), rows[table]);
      }
      const chats = actual.prepare('SELECT * FROM chats').all().map(({ temperatureOverride, maxTokensOverride, ...rest }) => rest);
      assert.deepEqual(chats, rows.chats.map((row) => ({ ...row })));
    } finally {
      actual.close();
    }
  } finally {
    db.close();
  }
});

test('chat overrides inherit live connection parameters independently and persist across restarts', async (t) => {
  const filename = database();
  let db = openStore(filename);
  const firstProvider = db.saveProvider(providerInput({ ...preset, temperature: 0.8, maxTokens: 4096 }));
  const secondProvider = db.saveProvider(providerInput({
    ...preset, name: 'Second fixture', baseUrl: 'https://fixture.example/v1', apiKey: 'other-fixture-key',
    temperature: 0.3, maxTokens: 2048,
  }));
  db.createChat();
  const chatA = db.snapshot().chat.id;
  db.createChat();
  const chatB = db.snapshot().chat.id;
  db.applyProvider(chatA, firstProvider, 'fixture/model', generationParameters({ temperature: 1.2, maxTokens: 8192 }));
  const bodies = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    bodies.push({ url: url.href, key: options.headers.Authorization, body: JSON.parse(options.body) });
    return Response.json({ choices: [{ message: { content: 'Fixture answer' }, finish_reason: 'stop' }] });
  });
  let finished;
  const generation = createGeneration(db, (event) => {
    if (!event.running) finished.resolve();
  }, () => assert.fail('Fixture could not save generation'));

  async function request(chatId) {
    db.selectChat(chatId);
    const current = db.snapshot().chat;
    finished = Promise.withResolvers();
    generation.start(db.chat(chatId), {
      mode: 'send', text: 'Fixture question', tailId: current.messages.at(-1)?.id ?? null,
    });
    await finished.promise;
    return bodies.at(-1);
  }

  try {
    let sent = await request(chatA);
    assert.equal(sent.body.temperature, 1.2);
    assert.equal(sent.body.max_tokens, 8192);
    sent = await request(chatB);
    assert.equal(sent.body.temperature, 0.8);
    assert.equal(sent.body.max_tokens, 4096);

    db.saveProvider(providerInput({ ...preset, id: firstProvider, apiKey: '', temperature: 0.4, maxTokens: 1024 }));
    assert.equal(db.provider(firstProvider).apiKey, preset.apiKey);
    sent = await request(chatA);
    assert.equal(sent.body.temperature, 1.2);
    assert.equal(sent.body.max_tokens, 8192);
    sent = await request(chatB);
    assert.equal(sent.body.temperature, 0.4);
    assert.equal(sent.body.max_tokens, 1024);

    db.applyProvider(chatA, secondProvider, 'fixture/second');
    sent = await request(chatA);
    assert.equal(sent.url, 'https://fixture.example/v1/chat/completions');
    assert.equal(sent.key, 'Bearer other-fixture-key');
    assert.equal(sent.body.temperature, 1.2);
    assert.equal(sent.body.max_tokens, 8192);
    db.applyProvider(chatA, secondProvider, 'fixture/second', generationParameters({ temperature: 0, maxTokens: null }));
    sent = await request(chatA);
    assert.equal(sent.body.temperature, 0);
    assert.equal(sent.body.max_tokens, 2048);
    assert.equal(db.provider(secondProvider).temperature, 0.3);
    assert.equal(db.provider(secondProvider).maxTokens, 2048);

    db.applyProvider(chatB, firstProvider, 'fixture/model', generationParameters({ temperature: null, maxTokens: null }));
    db.saveProvider(providerInput({ ...preset, id: firstProvider, apiKey: '', temperature: null, maxTokens: null }));
    sent = await request(chatB);
    assert.equal(Object.hasOwn(sent.body, 'temperature'), false);
    assert.equal(Object.hasOwn(sent.body, 'max_tokens'), false);
    generation.close();
    db.close();
    db = openStore(filename);
    assert.equal(db.chat(chatA).temperatureOverride, 0);
    assert.equal(db.chat(chatA).maxTokensOverride, null);
    assert.equal(db.chat(chatA).providerId, secondProvider);
    assert.equal(db.chat(chatB).temperatureOverride, null);
    assert.equal(db.chat(chatB).maxTokensOverride, null);
  } finally {
    generation.close();
    db.close();
  }
});

test('chat generation values use the existing numeric limits', () => {
  assert.deepEqual(generationParameters({ temperature: 0, maxTokens: 1 }), { temperature: 0, maxTokens: 1 });
  assert.deepEqual(generationParameters({ temperature: null, maxTokens: null }), { temperature: null, maxTokens: null });
  for (const temperature of [-1, 2.1, NaN, Infinity, '0.8', undefined]) {
    assert.throws(() => generationParameters({ temperature, maxTokens: null }), /Temperature/);
  }
  for (const maxTokens of [0, -1, 1.5, 2_147_483_648, Infinity, '4096', undefined]) {
    assert.throws(() => generationParameters({ temperature: null, maxTokens }), /token limit/);
  }
  assert.throws(() => generationParameters(null));
  assert.throws(() => generationParameters([]));
});

test('SQLite persists chat settings, and history changes require consent and the current tail', () => {
  const filename = database();
  let db = openStore(filename);
  assert.equal(db.snapshot().chats.length, 0);
  db.saveProvider(providerInput(preset));
  db.createChat();
  const id = db.snapshot().chat.id;
  db.renameChat(id, 'Проверка');
  db.pinChat(id, true);
  const first = db.beginGeneration(db.chat(id), { mode: 'send', text: 'Вопрос\n1', tailId: null });
  db.finishGeneration({ ...first, text: 'Ответ 1', usage: { inputTokens: 12, cost: 0 } }, 'done', null);
  const second = db.beginGeneration(db.chat(id), { mode: 'send', text: 'Вопрос 2', tailId: first.messageId });
  assert.deepEqual(second.context.map((item) => ({ ...item })), [
    { role: 'user', content: 'Вопрос\n1' },
    { role: 'assistant', content: 'Ответ 1' },
    { role: 'user', content: 'Вопрос 2' },
  ]);
  db.saveProgress(second.messageId, 'Частичный текст');
  const customId = db.saveProvider(providerInput({ ...preset, id: null, name: 'Другое подключение',
    baseUrl: 'https://custom.example/v1/', apiKey: 'other-fixture-key' }));
  db.setDefaultProvider(customId);
  assert.equal(db.chat(id).providerId, 1);
  db.close();

  db = openStore(filename);
  try {
    const before = db.snapshot();
    assert.equal(before.chat.name, 'Проверка');
    assert.equal(before.chats[0].pinned, 1);
    assert.equal(before.selected.providerId, customId);
    assert.equal(before.chat.model, 'fixture/model');
    assert.equal(before.providers[0].hasKey, 1);
    assert.equal(Object.hasOwn(before.providers[0], 'apiKey'), false);
    assert.equal(before.chat.messages.at(-1).status, 'interrupted');
    assert.equal(before.chat.messages.at(-1).text, 'Частичный текст');
    const firstUser = before.chat.messages[0].id;
    assert.throws(() => db.changeMessage(id, firstUser, second.messageId, false, 'Правка'), /Confirm/);
    assert.throws(() => db.changeMessage(id, firstUser, first.messageId, true, 'Правка'), /history has changed/);
    assert.throws(() => db.beginGeneration(db.chat(id), { mode: 'regenerate', messageId: first.messageId,
      tailId: second.messageId, confirmed: false }), /Confirm/);
    assert.equal(db.snapshot().chat.messages.length, 4);
    db.changeMessage(id, firstUser, second.messageId, true, 'Правка');
    assert.equal(db.snapshot().chat.messages.length, 1);
    assert.equal(db.snapshot().chat.messages[0].text, 'Правка');
    assert.equal(db.snapshot().chat.usage.inputTokens, 12);
    assert.equal(db.snapshot().chat.usage.costs[0].amount, 0);
    db.applyProvider(id, customId, 'configured-for-this-chat');
    assert.equal(db.snapshot().chat.model, 'configured-for-this-chat');
    assert.equal(db.snapshot().chat.messages.length, 1);
    db.deleteChat(id);
    assert.equal(db.snapshot().chat, null);
  } finally {
    db.close();
  }
});

test('editing a user message replaces its text and starts an answer in one transaction', () => {
  const filename = database();
  let db = openStore(filename);
  try {
    db.saveProvider(providerInput(preset));
    db.createChat();
    const { id } = db.snapshot().chat;
    const chat = db.chat(id);
    const first = db.beginGeneration(chat, { mode: 'send', tailId: null, text: '# Original' });
    db.finishGeneration({ ...first, text: 'Old answer', usage: {} }, 'done', null);
    const second = db.beginGeneration(chat, { mode: 'send', tailId: first.messageId, text: 'Later message' });
    db.finishGeneration({ ...second, text: 'Later answer', usage: {} }, 'done', null);

    const before = db.snapshot().chat;
    const user = before.messages[0];
    const command = {
      mode: 'edit', messageId: user.id, tailId: second.messageId, text: '**Updated**\n\n- one  ', confirmed: true,
    };
    assert.throws(() => db.beginGeneration(chat, { ...command, confirmed: false }), /Confirm/);
    assert.throws(() => db.beginGeneration(chat, { ...command, tailId: first.messageId }), /history has changed/);
    assert.equal(db.beginGeneration(chat, { ...command, confirmed: false, text: user.text }), null);
    assert.deepEqual(db.snapshot().chat, before);

    db.saveProvider(providerInput({ ...preset, id: chat.providerId, apiKey: '', clearKey: true }));
    const generation = createGeneration(db, assert.fail, assert.fail);
    assert.throws(() => generation.start(chat, command), /API key/);
    assert.deepEqual(db.snapshot().chat, before);
    db.saveProvider(providerInput({ ...preset, id: chat.providerId }));

    const fixture = new DatabaseSync(filename);
    try {
      fixture.exec(`
        CREATE TRIGGER reject_request BEFORE INSERT ON requests
        BEGIN SELECT RAISE(ABORT, 'Fixture request failure'); END;
      `);
      assert.throws(() => db.beginGeneration(chat, command), /Fixture request failure/);
      assert.deepEqual(db.snapshot().chat, before);
      fixture.exec('DROP TRIGGER reject_request');
    } finally {
      fixture.close();
    }

    const answer = db.beginGeneration(chat, command);
    assert.deepEqual(answer.context.map((item) => ({ ...item })), [{ role: 'user', content: command.text }]);
    const after = db.snapshot().chat.messages;
    assert.equal(after.length, 2);
    assert.deepEqual({ ...after[0] }, { ...user, text: command.text });
    assert.equal(after[1].id, answer.messageId);
    assert.equal(after[1].status, 'streaming');
    db.finishGeneration({ ...answer, text: '', usage: {} }, 'failed', 'Mock API error');
    db.close();

    db = openStore(filename);
    const reopened = db.snapshot().chat.messages;
    assert.deepEqual(reopened.map(({ id, text, status }) => ({ id, text, status })), [
      { id: user.id, text: command.text, status: 'done' },
      { id: answer.messageId, text: '', status: 'failed' },
    ]);
  } finally {
    db.close();
  }
});

test('HTTPS destination validation and credential isolation', () => {
  const db = openStore(database());
  try {
    for (const invalid of ['http://example.test', 'https://key@example.test', 'https://example.test?token=abc',
      'https://example.test#fragment', 'https:example.test']) {
      assert.throws(() => providerInput({ ...preset, baseUrl: invalid }), /HTTPS|https/);
    }
    assert.equal(providerInput({ ...preset, baseUrl: 'https://example.test/v1/chat/completions/' }).baseUrl,
      'https://example.test/v1');
    db.saveProvider(providerInput(preset));
    db.createChat();
    const chat = db.snapshot().chat;
    const generator = createGeneration(db, () => {}, assert.fail);
    db.saveProvider(providerInput({ ...preset, id: 1, baseUrl: 'https://other.example/v1', apiKey: '' }));
    assert.equal(db.provider(1).apiKey, '');
    assert.throws(() => generator.start(chat, { mode: 'send', tailId: null, text: 'Test' }), /Base URL/);
    db.applyProvider(chat.id, 1, 'model');
    assert.throws(() => generator.start(db.chat(chat.id), { mode: 'send', tailId: null, text: 'Test' }), /API key/);
    assert.deepEqual(db.snapshot().chat.messages, []);
  } finally {
    db.close();
  }
});

function chunks(pieces) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

test('Chat Completions handles split UTF-8 SSE, final usage, HTTP failures, and mid-stream errors', async (t) => {
  const received = [];
  const usage = {};
  const io = { signal: new AbortController().signal,
    onText: (text) => received.push(text), onUsage: (stats) => Object.assign(usage, stats) };
  const content = new TextEncoder().encode(
    ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"content":"Привет"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],\n' +
    'data: "usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7,"cost":0.001}}\n\n' +
    'data: [DONE]\n\n'
  );
  const mock = t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url.href, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer ' + preset.apiKey);
    assert.deepEqual(JSON.parse(options.body), {
      model: 'fixture/model', messages: [{ role: 'user', content: 'Тест' }], stream: true,
    });
    return chunks([...content].map((byte) => Uint8Array.of(byte)));
  });
  assert.equal(await chatCompletion(preset, [{ role: 'user', content: 'Тест' }], io), 'stop');
  assert.deepEqual(received, ['Привет']);
  assert.deepEqual(usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7, cost: 0.001, currency: 'USD' });

  mock.mock.mockImplementation(async () => Response.json({ error: { message: 'rejected ' + preset.apiKey } }, { status: 401 }));
  await assert.rejects(chatCompletion(preset, [], io), (error) =>
    error.message.includes('HTTP 401') && !error.message.includes(preset.apiKey));
  mock.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://other.test' } }));
  await assert.rejects(chatCompletion(preset, [], io), /redirect/);
  mock.mock.mockImplementation(async () => chunks([new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"Часть"}}]}\n\n' +
    'data: {"error":{"message":"Поток прерван провайдером"}}\n\n'
  )]));
  await assert.rejects(chatCompletion(preset, [], io), /Поток прерван провайдером/);
  assert.equal(received.at(-1), 'Часть');
  mock.mock.mockImplementation(async () => chunks([new TextEncoder().encode('data: not JSON\n\n')]));
  await assert.rejects(chatCompletion(preset, [], io), /JSON/);
});

test('all catalog presets use exactly one Chat Completions suffix and keep the configured API key', async (t) => {
  const { providerCatalog } = await import('../src/provider-catalog.mjs');
  assert.equal(providerCatalog.length, 12);
  assert.equal(new Set(providerCatalog.map(({ baseUrl }) => baseUrl)).size, 12);
  const requests = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    requests.push({ url: url.href, authorization: options.headers.Authorization });
    return Response.json({ choices: [{ message: { content: 'Test reply' }, finish_reason: 'stop' }] });
  });
  const io = { signal: new AbortController().signal, onText() {}, onUsage() {} };
  for (const [index, { name, baseUrl }] of providerCatalog.entries()) {
    const apiKey = `provider-key-${index}`;
    const url = baseUrl + '/chat/completions';
    const config = providerInput({ ...preset, id: null, name, baseUrl: url + '/', apiKey });
    assert.equal(config.baseUrl, baseUrl);
    assert.equal(await chatCompletion(config, [], io), 'stop');
    assert.deepEqual(requests.at(-1), { url, authorization: 'Bearer ' + apiKey });
  }
});

test('generation parameters are selected for the request host and model', async (t) => {
  const bodies = [];
  t.mock.method(global, 'fetch', async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: 'Test reply' }, finish_reason: 'stop' }] });
  });
  const io = { signal: new AbortController().signal, onText() {}, onUsage() {} };
  const cases = [
    [preset.baseUrl, 'openai/o4-mini', { temperature: 0.4, max_tokens: 96 }],
    ['https://api.groq.com/openai/v1', 'fixture/model', { temperature: 0.4, max_completion_tokens: 96 }],
    ['https://api.openai.com/v1', 'o4-mini', { max_completion_tokens: 96 }],
    ['https://api.openai.com/v1', 'gpt-6.1-terra', { max_completion_tokens: 96 }],
    ['https://api.openai.com/v1', 'gpt-5.4-mini', { temperature: 0.4, max_completion_tokens: 96 }],
    ['https://api.openai.com/v1', 'gpt-4o', { temperature: 0.4, max_completion_tokens: 96 }],
    ['https://api.refuseless.com/v1', 'fixture/model', { max_tokens: 96 }],
    ['https://custom.example/v1', 'o4-mini', { temperature: 0.4, max_tokens: 96 }],
  ];
  for (const [baseUrl, model, parameters] of cases) {
    await chatCompletion({ ...preset, baseUrl, model, temperature: 0.4, maxTokens: 96 }, [], io);
    assert.deepEqual(bodies.at(-1), { model, messages: [], stream: true, ...parameters }, baseUrl + '/' + model);
  }
});
