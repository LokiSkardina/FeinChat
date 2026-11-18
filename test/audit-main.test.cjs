const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { openStore } = require('../electron/store.cjs');
const { createGeneration } = require('../electron/generation.cjs');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
const temporary = path.join(root, '.cache/tmp');
fs.mkdirSync(temporary, { recursive: true });

async function boot({ unwritable = false } = {}) {
  const fixture = fs.mkdtempSync(path.join(temporary, 'main-audit-'));
  const app = new EventEmitter();
  const paths = {};
  const switches = {};
  const errors = [];
  const links = [];
  const web = new EventEmitter();
  web.mainFrame = { url: pathToFileURL(path.join(fixture, 'renderer/index.html')).href };
  web.send = () => {};
  web.setWindowOpenHandler = (fn) => { web.openWindow = fn; };
  let readyCalled = false;
  let opened;
  let window;
  let request;
  let quits = 0;
  Object.assign(app, {
    isPackaged: false,
    setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => true,
    commandLine: { appendSwitch: (name, value) => { switches[name] = value; } },
    setPath: (name, value) => { assert.equal(readyCalled, false); paths[name] = value; },
    getPath: (name) => paths[name],
    setAppLogsPath: (value) => { assert.equal(readyCalled, false); paths.logs = value; },
    whenReady: () => { readyCalled = true; return Promise.resolve(); },
    quit: () => {
      if (quits++) return;
      app.emit('before-quit');
      app.emit('will-quit');
    },
  });
  const browserSession = {
    setPermissionCheckHandler(fn) { this.check = fn; },
    setPermissionRequestHandler(fn) { this.permission = fn; },
    on(name, fn) { this[name] = fn; },
    webRequest: { onBeforeRequest(fn) { browserSession.beforeRequest = fn; } },
  };
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = web; window = this; }
    setBackgroundColor() {} isDestroyed() { return false; } show() {} isMinimized() { return false; }
    async loadFile(value) { assert.equal(value, path.join(fixture, 'renderer/index.html')); }
  }
  const electron = {
    app, BrowserWindow: Window, Menu: { setApplicationMenu() {} },
    clipboard: { writeText() {} }, dialog: { showErrorBox: (...args) => errors.push(args) },
    ipcMain: { handle: (channel, fn) => { assert.equal(channel, 'feinchat:request'); request = fn; } },
    nativeTheme: {}, session: { defaultSession: browserSession },
    shell: { openExternal: async (url) => { links.push(url); } },
  };
  const processStub = { execPath: process.execPath, env: {} };
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs' && unwritable) return { ...fs, mkdtempSync() { throw Object.assign(new Error('test EACCES'), { code: 'EACCES' }); } };
      if (name === './store.cjs') return { openStore: (filename) => { opened = openStore(filename); return opened; } };
      if (name === './generation.cjs') return { createGeneration };
      if (name.startsWith('./')) return require('../electron/' + name.slice(2));
      return require(name);
    },
    __dirname: path.join(fixture, 'electron'), process: processStub, URL,
  }, { filename: 'electron/main.cjs' });
  await delay(0);
  const event = { sender: web, senderFrame: web.mainFrame };
  return {
    fixture, paths, switches, errors, links, app, window, web, browserSession, opened, processStub,
    readyCalled, get quits() { return quits; },
    request: (command, args, sender = event) => request(sender, command, args),
  };
}

const provider = {
  id: null, name: 'Audit fixture', baseUrl: 'https://fixture.example/v1/chat/completions/',
  apiKey: 'synthetic-main-key', clearKey: false, model: 'fixture/model', temperature: null, maxTokens: null,
};

async function chat(app) {
  const saved = await app.request('provider:save', { provider });
  assert.equal(saved.ok, true);
  const result = await app.request('chat:create');
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(provider.apiKey), false);
  return result.state.chat;
}

test('main configures portable paths before ready and restricts windows, permissions, resources and IPC', async () => {
  const a = await boot();
  try {
    for (const name of ['appData', 'userData', 'sessionData', 'crashDumps', 'temp', 'logs']) {
      assert.ok(a.paths[name].startsWith(path.join(a.fixture, 'data')));
      assert.ok(fs.existsSync(a.paths[name]));
    }
    assert.equal(a.processStub.env.TEMP, a.paths.temp);
    assert.equal(a.processStub.env.TMP, a.paths.temp);
    assert.equal(a.switches.lang, 'en-US');
    assert.equal(a.switches['disk-cache-dir'], path.join(a.paths.sessionData, 'Cache'));
    const prefs = a.window.options.webPreferences;
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.spellcheck, false);
    assert.equal(a.web.openWindow().action, 'deny');
    for (const event of ['will-frame-navigate', 'will-redirect', 'will-attach-webview']) {
      let blocked = false;
      a.web.emit(event, { preventDefault: () => { blocked = true; } });
      assert.equal(blocked, true);
    }
    assert.equal(a.browserSession.check(), false);
    a.browserSession.permission(null, 'media', (granted) => assert.equal(granted, false));
    let prevented = false;
    a.browserSession['will-download']({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    for (const [url, cancel] of [
      [pathToFileURL(path.join(a.fixture, 'renderer/assets/index.js')).href, false],
      [pathToFileURL(path.join(a.fixture, 'data/feinchat.sqlite3')).href, true],
      ['https://unselected.example/image.png', true], ['http://localhost:1234/', true],
      ['file:///C:/Windows/win.ini', true], ['data:text/html,hello', true],
    ]) a.browserSession.beforeRequest({ url }, (result) => assert.equal(result.cancel, cancel));
    assert.equal((await a.request('read', {}, { sender: {}, senderFrame: a.web.mainFrame })).ok, false);
    assert.equal((await a.request('read', {}, { sender: a.web, senderFrame: { url: a.web.mainFrame.url } })).ok, false);
    assert.equal((await a.request('__proto__')).ok, false);
    assert.equal((await a.request('read', [])).ok, false);
    assert.equal((await a.request('chat:select', { chatId: '1' })).ok, false);
    assert.equal((await a.request('appearance:theme', { theme: 'system' })).ok, false);
    assert.equal((await a.request('message:copy', { content: 'x'.repeat(1_000_001) })).ok, false);
    for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'http://example.com',
      'https://user:pass@example.com', 'https://example.com\\@other.test', 'https://example.com\n/path']) {
      assert.equal((await a.request('link:open', { url })).ok, false);
    }
    assert.deepEqual(a.links, []);
    assert.equal((await a.request('link:open', { url: 'https://example.test/manual?q=1#part' })).ok, true);
    assert.deepEqual(a.links, ['https://example.test/manual?q=1#part']);
    const c = await chat(a);
    assert.equal((await a.request('chat:delete', { chatId: c.id, confirmed: false })).ok, false);
    assert.equal((await a.request('read')).state.chat.id, c.id);
  } finally { a.app.quit(); }
});

test('closing immediately after send aborts the request and preserves the user message', async () => {
  const previous = global.fetch;
  let signal;
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const a = await boot();
  try {
    const c = await chat(a);
    assert.equal((await a.request('generation:start', { chatId: c.id, mode: 'send', lastId: null, content: 'Immediately saved' })).ok, true);
    a.app.emit('window-all-closed');
    assert.equal(signal.aborted, true);
    const db = openStore(path.join(a.fixture, 'data/feinchat.sqlite3'));
    try {
      const messages = db.snapshot().chat.messages;
      assert.deepEqual(messages.map((m) => m.text), ['Immediately saved', '']);
      assert.equal(messages[1].status, 'stopped');
    } finally { db.close(); }
    assert.equal((await a.request('read')).ok, false);
  } finally { a.app.quit(); global.fetch = previous; }
});

test('closing during a stream flushes text received after its last checkpoint', async () => {
  const previous = global.fetch;
  let controller;
  let signal;
  const encoder = new TextEncoder();
  global.fetch = async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(value) {
        controller = value;
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const a = await boot();
  try {
    const c = await chat(a);
    const send = await a.request('generation:start', { chatId: c.id, mode: 'send', lastId: null, content: 'Partial test' });
    assert.equal(send.ok, true);
    const frame = (text) => controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'));
    frame('Committed ');
    await delay(10);
    frame('buffered text');
    await delay(10);
    assert.equal(a.opened.snapshot().chat.messages.at(-1).text, 'Committed ');
    a.app.quit();
    assert.equal(signal.aborted, true);
    const db = openStore(path.join(a.fixture, 'data/feinchat.sqlite3'));
    try {
      assert.equal(db.snapshot().chat.messages.at(-1).text, 'Committed buffered text');
      assert.equal(db.snapshot().chat.messages.at(-1).status, 'stopped');
    } finally { db.close(); }
  } finally { a.app.quit(); global.fetch = previous; }
});

test('an unwritable portable directory reports the path and never opens SQLite or falls back', async () => {
  const a = await boot({ unwritable: true });
  assert.equal(a.readyCalled, false);
  assert.equal(a.opened, undefined);
  assert.equal(a.window, undefined);
  assert.deepEqual(a.paths, {});
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0][1], /Move FeinChat to a writable folder/);
  assert.ok(a.errors[0][1].includes(path.join(a.fixture, 'data')));
  assert.equal(a.quits, 1);
});

test('preload exposes named operations only and removes its exact generation listener', async () => {
  const listeners = new EventEmitter();
  const invocations = [];
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/preload.cjs'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'feinchat'); bridge = value; } },
        ipcRenderer: {
          invoke: async (...args) => { invocations.push(args); },
          on: listeners.on.bind(listeners), removeListener: listeners.removeListener.bind(listeners),
        },
      };
    },
  });
  assert.equal(bridge.invoke, undefined);
  assert.equal(bridge.send, undefined);
  assert.equal(bridge.require, undefined);
  await bridge.read();
  assert.deepEqual(invocations[0], ['feinchat:request', 'read', undefined]);
  for (let index = 0; index < 50; index++) {
    let count = 0;
    const remove = bridge.onGeneration(() => count++);
    assert.equal(listeners.listenerCount('feinchat:generation'), 1);
    listeners.emit('feinchat:generation', {}, { revision: index });
    remove();
    assert.equal(listeners.listenerCount('feinchat:generation'), 0);
    assert.equal(count, 1);
  }
});
