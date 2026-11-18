const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chatCompletion } = require('../electron/api.cjs');
const { createGeneration } = require('../electron/generation.cjs');

const config = {
  id: 1, providerId: 1, baseUrl: 'https://fixture.example/v1', model: 'fixture/model',
  apiKey: 'fixture-secret-key', temperature: null, maxTokens: null,
};
const encoder = new TextEncoder();
const frame = (packet, newline = '\n') => 'data: ' + JSON.stringify(packet) + newline + newline;
const content = (text, finishReason = null, usage) => ({
  choices: [{ index: 0, delta: { content: text }, finish_reason: finishReason }],
  ...(usage && { usage }),
});

function response(parts, { end = true, failure, signal } = {}) {
  return new Response(new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      if (failure) controller.error(failure);
      else if (end) controller.close();
      else signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function callbacks() {
  const text = [];
  const usage = [];
  return {
    text, usage,
    signal: new AbortController().signal,
    onText: (part) => text.push(part),
    onUsage: (part) => usage.push(part),
  };
}

test('SSE framing tolerates every single split of LF, CRLF, and CR events', async (t) => {
  let pieces;
  t.mock.method(global, 'fetch', async () => response(pieces));
  for (const newline of ['\n', '\r\n', '\r']) {
    const source = ': heartbeat' + newline + newline +
      frame(content('Первый '), newline) + frame(content('ответ', 'stop'), newline) +
      frame({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }, newline) +
      'data: [DONE]' + newline + newline;
    for (let split = 0; split <= source.length; split++) {
      pieces = [source.slice(0, split), source.slice(split)];
      const io = callbacks();
      assert.equal(await chatCompletion(config, [], io), 'stop');
      assert.equal(io.text.join(''), 'Первый ответ', JSON.stringify({ newline, split }));
    }
  }
});

test('midstream usage is not promoted to confirmed final statistics', async (t) => {
  t.mock.method(global, 'fetch', async () => response([
    frame(content('Начало', null, { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5, cost: 0.1 })),
    frame(content(' и конец', 'stop')),
    'data: [DONE]\n\n',
  ]));
  const io = callbacks();
  await chatCompletion(config, [], io);
  assert.equal(io.text.join(''), 'Начало и конец');
  assert.deepEqual(io.usage, []);
});

test('a disconnected stream preserves text and never confirms provisional usage', async (t) => {
  t.mock.method(global, 'fetch', async () => response([
    frame(content('Сохранённая часть', null, { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 })),
  ]));
  const io = callbacks();
  await assert.rejects(chatCompletion(config, [], io), /before the API response was complete/);
  assert.equal(io.text.join(''), 'Сохранённая часть');
  assert.deepEqual(io.usage, []);
});

test('incomplete final JSON is reported without discarding preceding text', async (t) => {
  t.mock.method(global, 'fetch', async () => response([
    frame(content('Сохранённая часть')),
    'data: {"choices":[{"delta":{"content":"незавершённый',
  ]));
  const io = callbacks();
  await assert.rejects(chatCompletion(config, [], io), /JSON/);
  assert.equal(io.text.join(''), 'Сохранённая часть');
});

test('usage after the finish chunk is saved as one final snapshot', async (t) => {
  t.mock.method(global, 'fetch', async () => response([
    frame(content('Ответ', null, { completion_tokens: 1 })),
    frame(content('', 'stop')),
    frame({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.1 } }),
    'data: [DONE]\n\n',
  ]));
  const io = callbacks();
  await chatCompletion(config, [], io);
  assert.deepEqual(io.usage, [{ inputTokens: 4, outputTokens: 2, totalTokens: 6, cost: 0.1 }]);
});

test('OpenRouter repeated terminal reason and usage frame commit accounting only once', async (t) => {
  t.mock.method(global, 'fetch', async () => response([
    frame(content('Ответ')),
    frame(content('', 'stop')),
    frame(content('', 'stop', { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0.1 })),
    'data: [DONE]\n\n',
  ]));
  const io = callbacks();
  await chatCompletion({ ...config, baseUrl: 'https://openrouter.ai/api/v1' }, [], io);
  assert.deepEqual(io.usage, [{ inputTokens: 4, outputTokens: 2, totalTokens: 6, cost: 0.1, currency: 'USD' }]);
});

test('a late protocol error never confirms an otherwise terminal usage snapshot', async (t) => {
  t.mock.method(global, 'fetch', async () => response([
    frame(content('Ответ', 'stop', { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 })),
    frame({ error: { message: 'Fixture failure after finish' } }),
  ]));
  const io = callbacks();
  await assert.rejects(chatCompletion(config, [], io), /Fixture failure after finish/);
  assert.deepEqual(io.usage, []);
});

test('JSON usage preserves supported values and rejects invalid counters without inventing currency', async (t) => {
  t.mock.method(global, 'fetch', async () => Response.json({
    choices: [{ message: { content: 'Ответ' }, finish_reason: 'stop' }],
    usage: { input_tokens: 0, output_tokens: -1, total_tokens: '10', cost: 0.25 },
  }));
  const io = callbacks();
  await chatCompletion(config, [], io);
  assert.deepEqual(io.usage, [{ inputTokens: 0, cost: 0.25 }]);
});

test('HTTP errors stay explicit and redact the selected key and echoed authorization', async (t) => {
  let status;
  const calls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    calls.push({ url: url.href, options });
    return Response.json({ error: { message: `${config.apiKey} Bearer another-secret` } }, { status });
  });
  for (status of [401, 403, 413, 429, 500, 503]) {
    await assert.rejects(chatCompletion(config, [], callbacks()), (error) => {
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.equal(error.message.includes(config.apiKey), false);
      assert.equal(error.message.includes('another-secret'), false);
      return true;
    });
  }
  assert.equal(calls.length, 6);
  assert.equal(calls.every(({ url, options }) => url === config.baseUrl + '/chat/completions' &&
    options.redirect === 'manual' && options.headers.Authorization === 'Bearer ' + config.apiKey), true);
});

test('idle timeout aborts the request without retries or exposing its key', async (t) => {
  const realTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) =>
    realTimeout(callback, delay === 300_000 ? 10 : delay, ...args));
  let calls = 0;
  let requestSignal;
  t.mock.method(global, 'fetch', async (_url, options) => {
    calls++;
    requestSignal = options.signal;
    return new Promise((_resolve, reject) => {
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
    });
  });
  await assert.rejects(chatCompletion(config, [], callbacks()), /5 minutes/);
  assert.equal(calls, 1);
  assert.equal(requestSignal.aborted, true);
});

test('response limit rejects an oversized fragment and retains preceding accepted text', async (t) => {
  t.mock.method(global, 'fetch', async () => response([
    frame(content('Сохранённая часть')),
    frame(content('x'.repeat(1_000_000), 'stop', { completion_tokens: 1_000_000 })),
    'data: [DONE]\n\n',
  ]));
  const io = callbacks();
  await assert.rejects(chatCompletion(config, [], io), /1,000,000/);
  assert.equal(io.text.join(''), 'Сохранённая часть');
  assert.deepEqual(io.usage, []);
});

function fakeStore({ failSave = false, failFinish = false } = {}) {
  const saved = [];
  const finished = [];
  let nextId = 0;
  return {
    saved, finished,
    provider: () => config,
    beginGeneration: () => ({
      context: [{ role: 'user', content: 'Question' }], messageId: ++nextId, requestId: nextId,
    }),
    saveProgress(id, text) {
      if (failSave) throw new Error('Fixture disk is unavailable');
      saved.push({ id, text });
    },
    finishGeneration(job, status, error) {
      if (failFinish) throw new Error('Fixture disk is unavailable');
      finished.push({ id: job.messageId, text: job.text, status, error, usage: { ...job.usage } });
    },
  };
}

test('a persistent storage failure emits one failure notification and aborts the request', async (t) => {
  let requestSignal;
  t.mock.method(global, 'fetch', async (_url, options) => {
    requestSignal = options.signal;
    return response([frame(content('Часть'))], { end: false, signal: requestSignal });
  });
  const store = fakeStore({ failSave: true, failFinish: true });
  const notified = Promise.withResolvers();
  let failures = 0;
  const generation = createGeneration(store, () => {}, () => {
    failures++;
    notified.resolve();
  });
  generation.start(config, { mode: 'send', text: 'Question', tailId: null });
  await notified.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures, 1);
  assert.equal(requestSignal.aborted, true);
  assert.equal(generation.state().running, null);
});

test('a failed checkpoint still attempts to preserve text in its final save', async (t) => {
  t.mock.method(global, 'fetch', async (_url, options) =>
    response([frame(content('Последняя часть'))], { end: false, signal: options.signal }));
  const store = fakeStore({ failSave: true });
  const notified = Promise.withResolvers();
  let failures = 0;
  const generation = createGeneration(store, () => {}, () => { failures++; notified.resolve(); });
  generation.start(config, { mode: 'send', text: 'Question', tailId: null });
  await notified.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures, 1);
  assert.deepEqual(store.finished, [{ id: 1, text: 'Последняя часть', status: 'stopped', error: null, usage: {} }]);
});

test('Stop aborts once, preserves partial text, and rejects late text and usage from the old request', async (t) => {
  let stream;
  let requestSignal;
  let calls = 0;
  t.mock.method(global, 'fetch', async (_url, options) => {
    calls++;
    if (calls > 1) return Response.json({
      choices: [{ message: { content: 'Новый ответ' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
    requestSignal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode(frame(content('Сохранённая часть', null, { completion_tokens: 1 }))));
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const store = fakeStore();
  const events = [];
  const ready = Promise.withResolvers();
  const complete = Promise.withResolvers();
  const generation = createGeneration(store, (event) => {
    events.push(event);
    if (event.running && event.message.text) ready.resolve();
    if (!event.running && event.message.chatId === 2) complete.resolve();
  }, () => assert.fail('Fixture storage should stay available'));
  generation.start(config, { mode: 'send', text: 'Question', tailId: null });
  await ready.promise;
  assert.throws(() => generation.start(config, { mode: 'send', text: 'Duplicate', tailId: null }), /Stop/);
  generation.stop(1, 1);
  generation.stop(1, 1);
  assert.equal(requestSignal.aborted, true);
  generation.start({ ...config, id: 2 }, { mode: 'send', text: 'New question', tailId: null });
  stream.enqueue(encoder.encode(frame(content('Запоздавший текст', 'stop', { completion_tokens: 100 })) + 'data: [DONE]\n\n'));
  stream.close();
  await complete.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual(store.finished, [
    { id: 1, text: 'Сохранённая часть', status: 'stopped', error: null, usage: {} },
    { id: 2, text: 'Новый ответ', status: 'done', error: null, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
  ]);
  assert.equal(events.some((event) => event.message.text.includes('Запоздавший')), false);
  assert.equal(generation.state().running, null);
});
