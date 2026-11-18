const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, session, shell } = require('electron');
const { mkdirSync, mkdtempSync, rmdirSync } = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { openStore } = require('./store.cjs');
const { createGeneration } = require('./generation.cjs');
const { MAX_TEXT, UserError, requireInput, id, text, providerInput, generationParameters } = require('./input.cjs');

const projectDir = path.join(__dirname, '..');
const dataDir = path.join(app.isPackaged ? path.dirname(process.execPath) : projectDir, 'data');
const rendererDir = path.join(projectDir, 'renderer');
const page = path.join(rendererDir, 'index.html');
const pageUrl = pathToFileURL(page).href;
const canvasColors = { light: '#edeae3', dark: '#202628' };

let window;
let store;
let generation;
let quitting = false;

app.setName('FeinChat');
app.setAppUserModelId('personal.feinchat.desktop');
app.commandLine.appendSwitch('lang', 'en-US');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');

function setLocalPaths() {
  mkdirSync(dataDir, { recursive: true });
  // Try creating an entry even when all subdirectories already exist.
  rmdirSync(mkdtempSync(path.join(dataDir, '.write-')));
  for (const [name, relative] of Object.entries({
    appData: '', userData: 'chromium', sessionData: 'session', crashDumps: 'crashes', temp: 'tmp',
  })) {
    const directory = path.join(dataDir, relative);
    mkdirSync(directory, { recursive: true });
    app.setPath(name, directory);
  }
  const logs = path.join(dataDir, 'logs');
  mkdirSync(logs, { recursive: true });
  app.setAppLogsPath(logs);
  process.env.TEMP = app.getPath('temp');
  process.env.TMP = app.getPath('temp');
  app.commandLine.appendSwitch('log-file', path.join(logs, 'chromium.log'));
  app.commandLine.appendSwitch('disk-cache-dir', path.join(app.getPath('sessionData'), 'Cache'));
}

function showFatal(message) {
  dialog.showErrorBox('FeinChat', message);
  app.quit();
}

function openHttpsLink(value) {
  const error = 'Only HTTPS links without credentials can be opened.';
  requireInput(typeof value === 'string' && value.length <= 2048 &&
    /^https:\/\/[^/?#@\s]+(?:[/?#]|$)/i.test(value) && !/[\s\\\u0000-\u001f\u007f]/u.test(value), error);
  const url = URL.parse(value);
  requireInput(url?.protocol === 'https:' && url.hostname && !url.username && !url.password &&
    url.href.length <= 2048, error);
  return shell.openExternal(url.href);
}

function installIpc() {
  const snapshot = () => ({ ...store.snapshot(), ...generation.state() });
  function existingChat(value) {
    const chat = store.chat(id(value));
    requireInput(chat, 'Chat not found.');
    return chat;
  }
  function requireIdleChat(chatId) {
    requireInput(generation.state().running?.chatId !== chatId, 'Stop generation in this chat first.');
  }
  function editableChat(value) {
    const chat = existingChat(value);
    requireIdleChat(chat.id);
    return chat;
  }
  function existingProvider(value) {
    const provider = store.provider(id(value));
    requireInput(provider, 'Connection not found.');
    return provider;
  }
  const tailId = (value) => value === null ? null : id(value);
  const confirmation = (value) => {
    requireInput(typeof value === 'boolean');
    return value;
  };
  const messageText = (value) => text(value, MAX_TEXT, 'Message', { trim: false });

  const commands = {
    read: () => {},
    'appearance:theme': ({ theme }) => {
      requireInput(theme === 'light' || theme === 'dark', 'Choose a light or dark theme.');
      store.setTheme(theme);
      nativeTheme.themeSource = theme;
      window.setBackgroundColor(canvasColors[theme]);
    },
    'chat:read': ({ chatId }) => {
      const details = store.chatDetails(id(chatId));
      requireInput(details, 'Chat not found.');
      return details;
    },
    'chat:create': () => store.createChat(),
    'chat:select': ({ chatId }) => store.selectChat(existingChat(chatId).id),
    'chat:rename': ({ chatId, name }) => store.renameChat(existingChat(chatId).id, text(name, 120, 'Chat name')),
    'chat:pin': ({ chatId, pinned }) => store.pinChat(existingChat(chatId).id, confirmation(pinned)),
    'chat:delete': ({ chatId, confirmed }) => {
      requireInput(confirmation(confirmed), 'Confirm chat deletion.');
      store.deleteChat(editableChat(chatId).id);
    },
    'provider:save': ({ provider }) => store.saveProvider(providerInput(provider)),
    'provider:default': ({ providerId }) => {
      const provider = existingProvider(providerId);
      requireInput(provider.apiKey, 'Enter an API key for the default connection.');
      store.setDefaultProvider(provider.id);
    },
    'chat:model': ({ chatId, providerId, model, parameters }) => {
      const overrides = parameters === undefined ? undefined : generationParameters(parameters);
      store.applyProvider(editableChat(chatId).id, existingProvider(providerId).id, text(model, 256, 'Model ID'), overrides);
    },
    'message:edit': ({ chatId, messageId, lastId, confirmed, content }) => {
      const chat = existingChat(chatId);
      const target = store.message(chat.id, id(messageId));
      requireInput(target, 'Message not found.');
      const replacement = messageText(content);
      if (target.text === replacement) return;
      const currentTailId = tailId(lastId);
      const consent = confirmation(confirmed);
      if (target.role === 'user') {
        generation.start(chat, {
          mode: 'edit', messageId: target.id, tailId: currentTailId, confirmed: consent, text: replacement,
        });
      } else {
        requireIdleChat(chat.id);
        store.changeMessage(chat.id, target.id, currentTailId, consent, replacement);
      }
    },
    'message:delete': ({ chatId, messageId, lastId, confirmed }) => {
      store.changeMessage(editableChat(chatId).id, id(messageId), tailId(lastId), confirmation(confirmed), null);
    },
    'message:copy': ({ content }) =>
      clipboard.writeText(text(content, MAX_TEXT, 'Message', { trim: false, optional: true })),
    'link:open': ({ url }) => openHttpsLink(url),
    'generation:start': ({ chatId, mode, lastId, content, messageId, confirmed }) => {
      requireInput(['send', 'regenerate', 'reply'].includes(mode));
      generation.start(existingChat(chatId), {
        mode, tailId: tailId(lastId),
        text: mode === 'send' ? messageText(content) : null,
        messageId: mode === 'regenerate' ? id(messageId) : null,
        confirmed: mode === 'regenerate' && confirmation(confirmed),
      });
    },
    'generation:stop': ({ chatId, messageId }) => generation.stop(id(chatId), id(messageId)),
  };

  const operationErrors = {
    'message:copy': 'Could not copy text to the clipboard.',
    'link:open': 'Could not open the link in your browser.',
  };
  ipcMain.handle('feinchat:request', async (event, command, args = {}) => {
    if (quitting || !window || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== pageUrl ||
      !Object.hasOwn(commands, command) || !args || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, error: 'Operation unavailable.' };
    }
    try {
      const value = commands[command](args);
      if (command === 'message:copy' || command === 'link:open') {
        await value;
        return { ok: true };
      }
      if (command === 'chat:read') return { ok: true, chat: value };
      return { ok: true, state: snapshot(), savedProviderId: command === 'provider:save' ? value : undefined };
    } catch (error) {
      const message = operationErrors[command] ??
        'Could not complete the operation. Check write access to the data folder and available disk space.';
      return { ok: false, error: error instanceof UserError ? error.message : message };
    }
  });
}

function isLocalRendererFile(url) {
  try {
    const relative = path.relative(rendererDir, fileURLToPath(url));
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

async function start() {
  await app.whenReady();
  store = openStore(path.join(dataDir, 'feinchat.sqlite3'));
  const theme = store.theme();
  nativeTheme.themeSource = theme;
  generation = createGeneration(store, (event) => {
    if (!quitting && window && !window.isDestroyed()) window.webContents.send('feinchat:generation', event);
  }, () => {
    if (!quitting) showFatal('Could not save the response to SQLite. Check the data folder and available disk space.');
  });
  installIpc();
  const browserSession = session.defaultSession;
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  browserSession.on('will-download', (event) => event.preventDefault());
  browserSession.webRequest.onBeforeRequest((request, respond) => respond({ cancel: !isLocalRendererFile(request.url) }));

  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    title: 'FeinChat',
    width: 1120,
    height: 780,
    minWidth: 660,
    minHeight: 500,
    show: false,
    icon: path.join(projectDir, 'assets', 'icon.ico'),
    backgroundColor: canvasColors[theme],
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  await window.loadFile(page);
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  generation?.close();
});
app.on('will-quit', () => store?.close());
app.on('second-instance', () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

try {
  setLocalPaths();
  if (app.requestSingleInstanceLock()) {
    void start().catch((error) => showFatal(error instanceof UserError ? error.message :
      'Could not open the FeinChat window or database. Check the application files, access to the data folder, and available disk space.'));
  } else {
    app.quit();
  }
} catch {
  showFatal(`Could not prepare the folder for writing:\n${dataDir}\nMove FeinChat to a writable folder.`);
}
