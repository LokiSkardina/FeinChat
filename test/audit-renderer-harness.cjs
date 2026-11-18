const assert = require('node:assert/strict');
const { app, BrowserWindow, clipboard } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { openStore } = require('./electron/store.cjs');

const filename = path.join(__dirname, 'data', 'feinchat.sqlite3');
mkdirSync(path.dirname(filename), { recursive: true });
const seed = openStore(filename);
seed.saveProvider({ id: null, name: 'Audit fixture', baseUrl: 'https://audit.example/v1', apiKey: 'synthetic-audit-key', model: 'synthetic/model', temperature: null, maxTokens: null });
const scenarios = [];
for (const count of [100, 500, 1000]) {
  seed.createChat();
  const chat = seed.snapshot().chat;
  seed.renameChat(chat.id, 'Audit ' + count);
  scenarios.push({ id: chat.id, name: 'Audit ' + count, count });
}
seed.createChat();
const longChat = seed.snapshot().chat;
seed.renameChat(longChat.id, 'Audit long Markdown');
seed.createChat();
const blankChat = seed.snapshot().chat;
seed.renameChat(blankChat.id, 'Audit blank');
seed.close();
const db = new DatabaseSync(filename);
const append = db.prepare("INSERT INTO messages (chatId, role, text, status) VALUES (?, ?, ?, 'done')");
db.exec('BEGIN');
for (const { id, count } of scenarios) {
  for (let n = 0; n < count; n++) append.run(id, n % 2 ? 'assistant' : 'user',
    `Сообщение ${n + 1}. **Проверка истории**. Обычный текст с несколькими предложениями для измерения открытия и прокрутки.\nВторая строка.`);
}
const longParagraph = 'Длинный ответ модели с обычными предложениями и **выделением**. '.repeat(900);
const code = '```javascript\n' + Array.from({ length: 2000 }, (_, n) => `const value${n} = "${'x'.repeat(95)}";`).join('\n') + '\n```';
const table = '| ' + Array.from({ length: 12 }, (_, n) => 'Колонка ' + n).join(' | ') + ' |\n| ' + Array(12).fill('---').join(' | ') + ' |\n' +
  Array.from({ length: 300 }, (_, n) => '| ' + Array(12).fill('Ячейка ' + n).join(' | ') + ' |').join('\n');
for (const text of [longParagraph, longParagraph, longParagraph, code, table]) append.run(longChat.id, 'assistant', text);
db.prepare('UPDATE preferences SET chatId = ? WHERE id = 1').run(blankChat.id);
db.exec('COMMIT');
db.close();
let requests = 0;
global.fetch = async () => { requests++; throw new Error('The renderer audit must not issue API requests'); };
require('./electron/main.cjs');

async function until(label, callback, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await delay(20);
  }
  throw new Error('Timed out: ' + label);
}

async function run() {
  await app.whenReady();
  const win = await until('window', () => BrowserWindow.getAllWindows()[0]);
  const ui = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
  assert.equal(app.commandLine.getSwitchValue('lang'), 'en-US');
  assert.equal(app.getLocale(), 'en-US');
  assert.equal(await ui(() => document.documentElement.lang), 'en');
  assert.match(await ui(() => {
    const field = document.createElement('input');
    field.required = true;
    return field.validationMessage;
  }), /Please fill out this field/);
  const preferences = win.webContents.getLastWebPreferences();
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.sandbox, true);
  assert.deepEqual(await ui(() => ({ require: typeof require, process: typeof process })),
    { require: 'undefined', process: 'undefined' });
  const localPaths = {};
  for (const key of ['appData', 'userData', 'sessionData', 'crashDumps', 'logs', 'temp']) {
    localPaths[key] = app.getPath(key);
    const relative = path.relative(path.join(__dirname, 'data'), localPaths[key]);
    assert.ok(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), `${key} must remain inside fixture/data`);
  }
  const ready = (name, count) => until('render ' + name, () => ui((title, length) =>
    document.querySelector('h1')?.textContent === title && document.querySelectorAll('.message').length === length,
  name, count));
  const settle = () => ui(() => new Promise((resolve) => {
    const fallback = setTimeout(resolve, 200);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); resolve(); }));
  }));
  const select = async (name, count) => {
    const start = performance.now();
    assert.equal(await ui((title) => {
      const button = [...document.querySelectorAll('.chat-name')].find((node) => node.title === title);
      if (!button || button.disabled) return false;
      button.click(); return true;
    }, name), true);
    await ready(name, count);
    await settle();
    return Math.round(performance.now() - start);
  };
  await ready('Audit blank', 0);
  const metrics = [];
  for (const scenario of scenarios) {
    const openMs = await select(scenario.name, scenario.count);
    const scroll = await ui(async () => {
      const scroller = document.querySelector('.history');
      const samples = [];
      for (let n = 0; n < 20; n++) {
        const start = performance.now();
        scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * n / 19;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 200);
          requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
        });
        samples.push(performance.now() - start);
      }
      return { medianMs: samples.sort((a, b) => a - b)[10], maximumMs: Math.max(...samples) };
    });
    const memory = app.getAppMetrics().find((item) => item.pid === win.webContents.getOSProcessId()).memory;
    metrics.push({ messages: scenario.count, openMs, scrollMedianMs: Math.round(scroll.medianMs), scrollMaxMs: Math.round(scroll.maximumMs), rendererPrivateMB: Math.round(memory.privateBytes / 1024) });
  }
  const longOpenMs = await select('Audit long Markdown', 5);
  assert.equal(await ui(() => document.querySelectorAll('.markdown-table-scroll tbody tr').length), 300);
  assert.equal(await ui(() => document.querySelectorAll('pre code').length), 1);
  for (const [width, height] of [[1540, 900], [660, 500]]) {
    win.setSize(width, height);
    await settle();
    assert.equal(await ui(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Long Markdown must stay inside window');
    assert.equal(await ui(() => {
      const history = document.querySelector('.history');
      return history.scrollWidth <= history.clientWidth + 1;
    }), true, 'Code/table scrolling must remain inside their containers');
  }
  const longMemory = app.getAppMetrics().find((item) => item.pid === win.webContents.getOSProcessId()).memory;
  metrics.push({ messages: 5, markdownChars: 3 * longParagraph.length + code.length + table.length, openMs: longOpenMs, rendererPrivateMB: Math.round(longMemory.privateBytes / 1024) });
  win.setSize(1220, 800);
  await select(scenarios[0].name, 100);
  // Reading earlier history must not jump to the end after an unrelated state update.
  await ui(() => { document.querySelector('.history').scrollTop = 200; });
  await delay(50);
  const scrollBefore = await ui(() => document.querySelector('.history').scrollTop);
  await ui(() => document.querySelector('.theme-button').click());
  await settle();
  assert.equal(await ui(() => document.querySelector('.history').scrollTop), scrollBefore);
  // Copy status describes the text that was copied, even when an edit keeps the same message ID.
  await ui(() => document.querySelector('.assistant:last-child button[aria-label="Copy"]').click());
  await until('copied status', () => ui(() => Boolean(document.querySelector('.assistant:last-child button[aria-label="Copied"]'))));
  const copiedText = await clipboard.readText();
  assert.ok(copiedText.includes('Сообщение 100'));
  await ui(() => document.querySelector('.assistant:last-child button[aria-label="Edit"]').click());
  await until('edit dialog', () => ui(() => Boolean(document.querySelector('dialog[open] textarea'))));
  await ui(() => {
    const input = document.querySelector('dialog[open] textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Изменённый ответ после копирования.');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  await ui(() => document.querySelector('dialog[open] button[type="submit"]').click());
  await until('edited response', () => ui(() => document.querySelector('.assistant:last-child .message-text')?.textContent === 'Изменённый ответ после копирования.'));
  assert.equal(await clipboard.readText(), copiedText, 'Editing must not replace the clipboard');
  assert.equal(await ui(() => Boolean(document.querySelector('.assistant:last-child button[aria-label="Copy"]'))), true,
    'An edited message must not claim its new text is already copied');
  assert.equal(requests, 0, 'Synthetic history and assistant editing need no API');
  const report = { runtime: process.versions, metrics, copiedStatusAfterEdit: 'passed', scrollPosition: 'passed', sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, localPaths, requests };
  writeFileSync(path.join(__dirname, 'renderer-audit-results.json'), JSON.stringify(report, null, 2));
  console.log('Renderer audit passed: ' + JSON.stringify(report));
  win.close();
}
run().catch((error) => { console.error(error); app.exit(1); });
