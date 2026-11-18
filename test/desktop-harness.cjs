const assert = require('node:assert/strict');
const { app, BrowserWindow, clipboard, shell } = require('electron');
const { existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const calls = [];
const externalLinks = [];
const scriptedReplies = [];
let aborted = false;
const openExternal = async (url) => { externalLinks.push(url); };
shell.openExternal = openExternal;
assert.equal(require('electron').shell.openExternal, openExternal, 'Browser launches must be mocked in desktop checks');
const openRouter = 'https://openrouter.ai/api/v1/chat/completions';
const deepSeek = 'https://api.deepseek.com/chat/completions';
const custom = 'https://provider.example/v1/chat/completions';
const originalKey = 'router-fixture-key';
const deepSeekKey = 'deepseek-fixture-key';
const backupKey = 'deepseek-backup-fixture-key';
const customKey = 'custom-fixture-key';
const firstPrompt = 'Как спланировать неделю, чтобы оставить вечера свободными?';
const firstFragment = 'Привет! Выбери три главных дела и поставь их на те часы, когда тебе проще сосредоточиться.';
const firstContinuation = '\n\nМелкие задачи собери в один блок, а между встречами оставь немного времени в запасе. Так новые дела реже будут сдвигать планы на вечер.';
const firstReply = firstFragment + firstContinuation;
const markdownChat = 'Markdown и редактирование';
const markdownPrompt = '# Вопрос в Markdown\n\n**Важный** запрос с *уточнением*.';
const markdownLink = 'https://example.test/reference?q=1#section';
const codeFirstLine = '  const number = 2;';
const codeLastLine = '  const longLine = "' + 'x'.repeat(340) + '";';
const markdownCode = codeFirstLine + '\n' + codeLastLine;
const markdownStart = [
  '## Ответ Markdown', '', '**Жирное** и *курсив*, ~~зачёркивание~~ и `inline()`.',
  '', 'Первая строка', 'Вторая строка', '', '- Первый пункт', '- Второй пункт',
  '', '1. Номер один', '2. Номер два', '', '> Цитата', '', '---', '', '```javascript', codeFirstLine,
].join('\n');
const markdownContinuation = [
  '', codeLastLine, '```', '', '| Столбец | Значение |', '| --- | --- |', '| Код | 2 |',
  '', '[Документация](' + markdownLink + ')',
  '', '[Запрет JavaScript](javascript:alert%281%29)', '[Запрет файла](file:///D:/secret.txt)',
  '[Запрет данных](data:text/html,hello)', '[Запрет HTTP](http://example.test/unsecured)',
  '[Запрет секрета](https://username:password@example.test/path)',
  '', '<script>document.body.dataset.markdownProbe = "executed"</script>',
  '', '<div id="raw-markdown-html">HTML без исполнения</div>',
  '', '<img id="raw-markdown-image" src="https://example.test/raw.png">',
  '', '![Внешняя картинка](https://example.test/markdown.png)',
].join('\n');
const markdownReply = markdownStart + markdownContinuation;
const revisedPrompt = '## Исправленный вопрос\n\nНужен **новый ответ**.';
const manualReply = '### Ручной ответ\n\nТекст сохранён **без генерации**.';
const parameterChatA = 'Параметры A';
const parameterChatB = 'Параметры B';
const geometryReply = [
  '## Широкая переписка',
  '',
  'Длинный ответ должен использовать удобную ширину общего контейнера, сохраняя хорошую читаемость. '.repeat(12),
  '',
  '> Настоящая цитата Markdown сохраняет свою вертикальную линию.',
  '',
  '```text',
  'Очень длинная строка кода ' + 'x'.repeat(420),
  '```',
  '',
  '| ' + Array.from({ length: 14 }, (_, index) => 'Колонка ' + (index + 1)).join(' | ') + ' |',
  '| ' + Array(14).fill('---').join(' | ') + ' |',
  '| ' + Array(14).fill('Данные таблицы').join(' | ') + ' |',
].join('\n');
const catalog = {
  OpenRouter: 'https://openrouter.ai/api/v1',
  'Venice.ai': 'https://api.venice.ai/api/v1',
  'abliteration.ai': 'https://api.abliteration.ai/v1',
  'UncensoredLLM.ai': 'https://api.uncensoredllm.ai/v1',
  OpenUncensored: 'https://api.openuncensored.com/v1',
  Refuseless: 'https://api.refuseless.com/v1',
  RouterHub: 'https://api.routerhub.ai/v1',
  Morph: 'https://api.morphllm.com/v1',
  DeepSeek: 'https://api.deepseek.com',
  Groq: 'https://api.groq.com/openai/v1',
  'Together AI': 'https://api.together.ai/v1',
  OpenAI: 'https://api.openai.com/v1',
};

function stream(text, { signal, stop = false, usage, continuation = '\nВторая строка.', release } = {}) {
  const encoder = new TextEncoder();
  let timer;
  let cancelled = false;
  return new Response(new ReadableStream({
    start(controller) {
      const frame = (data) => controller.enqueue(encoder.encode('data: ' + JSON.stringify(data) + '\r\n\r\n'));
      frame({ choices: [{ delta: { content: text } }] });
      if (stop) {
        signal.addEventListener('abort', () => {
          aborted = true;
          controller.error(signal.reason);
        }, { once: true });
        return;
      }
      const finish = () => {
        if (cancelled) return;
        frame({ choices: [{ delta: { content: continuation }, finish_reason: 'stop' }], usage });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      };
      if (release) void release.then(finish);
      else timer = setTimeout(finish, 500);
    },
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

global.fetch = async (url, options) => {
  const data = JSON.parse(options.body);
  const call = { url: url.href, key: options.headers.Authorization.slice(7), data };
  calls.push(call);
  const scripted = scriptedReplies.shift();
  if (scripted) return scripted(options);
  const usage = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12, cost: 0.004 };
  if (calls.length === 1) return stream(firstFragment, { usage, continuation: firstContinuation });
  if (calls.length === 2) return stream('Сохранённая часть.', { signal: options.signal, stop: true });
  if (calls.length === 3) return Response.json({ error: { message: 'Лимит тестового провайдера' } }, { status: 429 });
  return stream('Ответ второго провайдера.', { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
};

require('./electron/main.cjs');

async function until(label, callback, time = 8_000) {
  const deadline = Date.now() + time;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await delay(35);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function run(phase) {
  await app.whenReady();
  const win = await until('FeinChat window', () => BrowserWindow.getAllWindows()[0]);
  const ui = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
  const content = (value) => until(value, () => ui((expected) => document.body.innerText.includes(expected), value));
  const click = (selector) => until(selector, () => ui((value) => {
    const target = document.querySelector(value);
    if (!target || target.disabled) return false;
    target.click();
    return true;
  }, selector));
  const button = (label, selector = 'button') => until(label, () => ui((value, matches) => {
    const target = [...document.querySelectorAll(matches)].find((item) => !item.disabled && item.getClientRects().length &&
      (item.textContent.trim() === value || item.getAttribute('aria-label') === value));
    if (!target) return false;
    target.click();
    return true;
  }, label, selector));
  const input = (selector, value) => until(selector, () => ui((matches, text) => {
    const element = document.querySelector(matches);
    if (!element || element.disabled) return false;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, text);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    return true;
  }, selector, value));
  const read = async () => {
    const reply = await ui(() => window.feinchat.read());
    assert.equal(reply.ok, true, reply.error);
    return reply.state;
  };
  const capture = async (name) => {
    await settle();
    await ui(() => Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime < 500)
      .map((animation) => animation.finished.catch(() => {}))));
    const image = await win.webContents.capturePage();
    assert.equal(image.isEmpty(), false);
    writeFileSync(path.join(__dirname, name + '.png'), image.toPNG());
  };
  const send = async (text) => {
    await input('.compose-row textarea', text);
    await click('.send');
  };
  const openSettings = () => click('button[aria-label="Settings"]');
  const closeSettings = () => click('button[aria-label="Close settings"]');
  const chatActions = (name) => click(`.chat-menu[aria-label="Chat actions: ${name}"]`);
  const waitForReply = () => until('finished generation', async () => (await read()).running === null);
  async function openChatParameters(name) {
    await chatActions(name);
    await button('Chat settings', '.chat-actions:popover-open button');
    await until('parameters for ' + name, () => ui((expected) =>
      document.querySelector('.chat-settings-name')?.textContent === expected, name));
  }
  async function switchTheme(theme) {
    await button(theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme');
    await until(theme + ' theme', () => ui((expected) => document.documentElement.dataset.theme === expected, theme));
    assert.equal((await read()).theme, theme);
  }
  const settle = () => ui(() => new Promise((resolve) => {
    const fallback = setTimeout(resolve, 200);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(fallback);
      resolve();
    }));
  }));
  const box = (selector) => ui((matches) => document.querySelector(matches)?.getBoundingClientRect().toJSON(), selector);
  const textarea = '.compose-row textarea';
  const popup = '.chat-actions:popover-open';

  const visiblePoint = (selector) => until('visible ' + selector, () => ui((matches) => {
    const target = document.querySelector(matches);
    if (!target || target.disabled) return false;
    const rect = target.getBoundingClientRect();
    const x = Math.floor(rect.left + rect.width / 2);
    const y = Math.floor(rect.top + rect.height / 2);
    return target.contains(document.elementFromPoint(x, y)) && { x, y };
  }, selector));
  function mouse(type, point, options = {}) {
    win.webContents.sendInputEvent({ type, ...point, ...options });
  }
  async function pointerClick(selector) {
    const point = await visiblePoint(selector);
    mouse('mouseMove', point);
    mouse('mouseDown', point, { button: 'left', clickCount: 1 });
    mouse('mouseUp', point, { button: 'left', clickCount: 1 });
    await settle();
  }
  function key(keyCode, modifiers = []) {
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers });
  }
  async function checkLayout() {
    assert.ok(await ui(() => {
      const sidebar = document.querySelector('.sidebar-header');
      const controls = [...sidebar.querySelectorAll('button')];
      return document.documentElement.scrollWidth <= innerWidth + 1 &&
        controls.length >= 2 && controls.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
        });
    }), 'Sidebar controls and main content should fit within the window');
  }
  async function resize(size) {
    win.setSize(...size);
    await settle();
    const actual = win.getSize();
    assert.ok(actual.every((value, index) => Math.abs(value - size[index]) <= 2),
      'Expected window size ' + size.join('×') + ', got ' + actual.join('×'));
    await checkLayout();
  }
  async function dragText(selector) {
    const points = await ui((matches) => {
      const selection = window.getSelection();
      selection.removeAllRanges();
      const walker = document.createTreeWalker(document.querySelector(matches), NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getClientRects()[0];
        if (!rect || rect.width < 20) continue;
        const y = Math.round(rect.top + rect.height / 2);
        return [{ x: Math.ceil(rect.left + 1), y }, { x: Math.floor(rect.right - 1), y }];
      }
      return null;
    }, selector);
    assert.ok(points, 'Could not locate text to drag in ' + selector);
    const [start, end] = points;
    mouse('mouseMove', start);
    mouse('mouseDown', start, { button: 'left', clickCount: 1 });
    await settle();
    mouse('mouseMove', end, { modifiers: ['leftbuttondown'] });
    await settle();
    mouse('mouseUp', end, { button: 'left', clickCount: 1 });
    await settle();
    return ui(() => window.getSelection().toString());
  }
  async function checkComposer() {
    const initial = (await box(textarea)).height;
    assert.ok(initial < 65, 'Empty composer should start compact');
    await input(textarea, 'Слово '.repeat(65));
    await until('composer grows for wrapped text', async () => (await box(textarea)).height > initial + 10);
    const contents = 'Текст на отдельной строке\n'.repeat(60).trimEnd();
    await input(textarea, contents);
    await until('composer scrolls at its height limit', () => ui((selector) => {
      const field = document.querySelector(selector);
      return field.scrollHeight > field.clientHeight && field.clientHeight < innerHeight / 2;
    }, textarea));
    const field = await box('.compose-row');
    const sendButton = await box('.send');
    assert.ok(sendButton.right <= field.right && sendButton.bottom <= field.bottom && sendButton.top >= field.top,
      'Send button should be inside the composer');

    await ui((selector) => {
      const field = document.querySelector(selector);
      field.focus();
      field.setSelectionRange(0, 0);
      document.addEventListener('copy', (event) => {
        event.preventDefault();
        window.testCopiedSelection = field.value.slice(field.selectionStart, field.selectionEnd);
      }, { once: true });
    }, textarea);
    key('A', ['control']);
    await until('Ctrl+A selects the composer text', () => ui((selector) => {
      const field = document.querySelector(selector);
      return field.selectionStart === 0 && field.selectionEnd === field.value.length;
    }, textarea));
    key('C', ['control']);
    await until('Ctrl+C copies the composer selection', () => ui((value) => window.testCopiedSelection === value, contents));
    await input(textarea, '');
    await until('empty composer returns to its initial height', async () => Math.abs((await box(textarea)).height - initial) < 1);
  }
  async function useSetting(selector) {
    await ui((matches) => document.querySelector(matches).scrollIntoView({ block: 'center' }), selector);
    await pointerClick(selector);
  }
  const catalogButton = '.provider-card';
  const chatPicker = '.chat-settings-form select';
  const row = (providerId) => `.connection-row[data-connection-id="${providerId}"]`;
  const options = (selector) => ui((matches) => Array.from(document.querySelector(matches).options, (option) => [
    option.value, option.textContent.trim(),
  ]), selector);
  const formFields = () => ui(() => {
    const form = document.querySelector('.provider-form');
    return form && ['name', 'baseUrl', 'apiKey', 'model'].map((name) => form.elements[name].value);
  });
  async function selectPreset(name, baseUrl, value = name) {
    await click(`${catalogButton}[data-provider="${value}"]`);
    await until('provider fields for ' + value, async () => {
      const fields = await formFields();
      return fields && fields[0] === name && fields[1] === baseUrl;
    });
    assert.deepEqual(await formFields(), [name, baseUrl, '', '']);
  }
  async function saveConnection({ name, baseUrl, key: apiKey, model, temperature = '', maxTokens = '' }) {
    for (const [field, value] of Object.entries({ name, baseUrl, apiKey, model, temperature, maxTokens })) {
      await input('input[name="' + field + '"]', value);
    }
    await button('Save connection', '.provider-form button');
    const saved = await until('saved connection ' + name, async () =>
      (await read()).providers.find((provider) => provider.name === name && provider.model === model));
    await until('saved connection appears in the list', () => ui((selector, expectedName, expectedModel) => {
      const connection = document.querySelector(selector);
      return connection?.querySelector('.connection-name').textContent === expectedName &&
        connection.querySelector('.connection-model').textContent === expectedModel;
    }, row(saved.id), name, model));
    assert.equal(saved.hasKey, 1);
    return saved;
  }
  async function checkCatalog() {
    const before = await read();
    assert.deepEqual(before.providers.map(({ name }) => name), ['OpenRouter']);
    assert.equal(await ui(() => Boolean(document.querySelector('.settings-body select'))), false);
    assert.equal(await ui(() => document.querySelector('.connection-row .connection-default')?.textContent), 'Default');
    assert.equal(await ui(() => Boolean(document.querySelector('button.connection-default'))), false);
    await button('Add connection');
    const choices = await ui((selector) => [...document.querySelectorAll(selector)].map((button) => button.dataset.provider), catalogButton);
    assert.deepEqual(choices.sort(), [...Object.keys(catalog), 'custom'].sort());
    for (const [name, baseUrl] of Object.entries(catalog)) {
      await selectPreset(name, baseUrl);
      await click('.settings-back');
    }

    await selectPreset('OpenAI', catalog.OpenAI);
    await input('input[name="apiKey"]', 'discarded-fixture-key');
    await input('input[name="model"]', 'fixture/discarded');
    await click('.settings-back');
    await selectPreset('DeepSeek', catalog.DeepSeek);
    assert.deepEqual(await read(), before);
    assert.equal(calls.length, 2, 'Choosing catalog profiles must not send API requests');

    const primary = await saveConnection({ name: 'DeepSeek основной', baseUrl: deepSeek + '/',
      key: deepSeekKey, model: 'fixture/deepseek', temperature: '0.6' });
    assert.equal(primary.baseUrl, catalog.DeepSeek, 'A pasted full endpoint is normalized to its Base URL');
    await button('Add connection');
    await selectPreset('DeepSeek', catalog.DeepSeek);
    const draftBackup = await saveConnection({ name: 'DeepSeek запасной', baseUrl: catalog.DeepSeek,
      key: backupKey, model: 'fixture/deepseek-backup', maxTokens: '30' });
    await button('Add connection');
    await selectPreset('', '', 'custom');
    const manual = await saveConnection({ name: 'Свой API', baseUrl: 'https://provider.example/v1',
      key: customKey, model: 'fixture/custom' });
    await click(`${row(draftBackup.id)} .connection-edit`);
    await until('editing the saved backup connection', async () => (await formFields())?.[0] === draftBackup.name);
    const backup = await saveConnection({ name: 'DeepSeek резерв', baseUrl: catalog.DeepSeek,
      key: '', model: draftBackup.model, maxTokens: '40' });
    assert.equal(backup.id, draftBackup.id);
    const after = await read();
    assert.deepEqual(after.providers, [...before.providers, primary, backup, manual]);
    assert.deepEqual(after.chat, before.chat, 'Saving provider profiles must preserve the open chat');
    assert.equal(after.selected.providerId, before.selected.providerId);
    assert.deepEqual(await ui(() => Array.from(document.querySelectorAll('.connection-name'), (name) => name.textContent)),
      after.providers.map(({ name }) => name));

    await button(`Set ${backup.name} as default`, `${row(backup.id)} button.connection-default`);
    await until('default provider selection', async () => (await read()).selected.providerId === backup.id);
    assert.equal(await ui((selector) => document.querySelector(selector)?.textContent, `${row(backup.id)} span.connection-default`),
      'Default');
    return { primary, backup, manual };
  }
  async function applyChatProvider(providerId, model = null) {
    const { chat, providers } = await read();
    await openChatParameters(chat.name);
    assert.deepEqual(await options(chatPicker), providers.map(({ id, name }) => [String(id), name]));
    assert.ok(await ui(() => !document.querySelector('dialog[aria-label="Chat settings"] input[name="apiKey"], dialog[aria-label="Chat settings"] input[name="baseUrl"]')));
    await input(chatPicker, String(providerId));
    if (model) await input('.chat-settings-form input[name="model"]', model);
    await button('Apply to chat');
    await until('applied chat parameters for ' + providerId, async () => {
      const current = (await read()).chat;
      return current.providerId === providerId && (!model || current.model === model);
    });
    await closeSettings();
  }
  async function namedChat(name) {
    await click('.new-chat');
    await until('new chat for ' + name, async () => (await read()).chat.name === 'New chat');
    await chatActions('New chat');
    await button('Rename', '.chat-actions button');
    await input('dialog[open] input', name);
    await button('Save', 'dialog[open] button');
    return until('chat named ' + name, async () => {
      const current = (await read()).chat;
      return current.name === name && current;
    });
  }

  async function setChatGeneration(temperature, maxTokens) {
    const current = (await read()).chat;
    await openChatParameters(current.name);
    await input('.chat-settings-form input[name="temperature"]', temperature);
    await input('.chat-settings-form input[name="maxTokens"]', maxTokens);
    await button('Apply to chat');
    await until('chat generation parameters are saved', async () => {
      const chat = (await read()).chat;
      return chat.temperatureOverride === (temperature === '' ? null : Number(temperature)) &&
        chat.maxTokensOverride === (maxTokens === '' ? null : Number(maxTokens));
    });
    if (temperature === '0' && maxTokens === '8192') await capture('chat-parameters-overrides');
    await closeSettings();
  }

  async function requestGenerationParameters(temperature, maxTokens, key = backupKey) {
    const before = calls.length;
    scriptedReplies.push(() => stream('Параметры подтверждены.', { continuation: '' }));
    await send('Проверить параметры ' + before);
    const request = await until('generation request with chat parameters', () => calls[before]);
    await waitForReply();
    assert.equal(request.key, key);
    assert.equal(request.data.temperature, temperature);
    assert.equal(request.data.max_tokens, maxTokens);
  }

  async function updateConnectionGeneration(provider, temperature, maxTokens) {
    await openSettings();
    await click(`${row(provider.id)} .connection-edit`);
    await until('connection edit form', async () => (await formFields())?.[0] === provider.name);
    const saved = await saveConnection({
      name: provider.name, baseUrl: provider.baseUrl, key: '', model: provider.model, temperature, maxTokens,
    });
    assert.equal(saved.id, provider.id);
    await closeSettings();
  }

  async function removeCurrentChat() {
    const { name } = (await read()).chat;
    await chatActions(name);
    await button('Delete', '.chat-actions button');
    await button('Delete', 'dialog[open] button');
    await until('deleted fixture ' + name, async () => !(await read()).chats.some((chat) => chat.name === name));
  }

  async function checkConversationGeometry() {
    const originalSize = win.getSize();
    scriptedReplies.push(() => stream(geometryReply, { continuation: '' }));
    await send('Проверь широкую переписку.');
    await waitForReply();
    scriptedReplies.push(() => stream('Короткий ответ.', { continuation: '' }));
    await send('И короткий ответ.');
    await waitForReply();

    for (const [size, captureName] of [[[1540, originalSize[1]], 'conversation-wide'], [win.getMinimumSize(), 'conversation-compact']]) {
      await resize(size);
      const layout = await ui(() => {
        const list = document.querySelector('.message-list');
        const listRect = list.getBoundingClientRect();
        const listStyle = getComputedStyle(list);
        const contentLeft = listRect.left + parseFloat(listStyle.paddingLeft);
        const contentRight = listRect.right - parseFloat(listStyle.paddingRight);
        const assistants = [...list.querySelectorAll('.message.assistant')];
        const longAnswer = assistants.at(-2);
        const shortAnswer = assistants.at(-1);
        const user = [...list.querySelectorAll('.message.user')].at(-1);
        const quote = longAnswer.querySelector('blockquote');
        const code = longAnswer.querySelector('pre');
        const table = longAnswer.querySelector('.markdown-table-scroll');
        const history = document.querySelector('.history');
        const composer = document.querySelector('.composer').getBoundingClientRect();
        const main = document.querySelector('main').getBoundingClientRect();
        const longRect = longAnswer.getBoundingClientRect();
        const shortRect = shortAnswer.getBoundingClientRect();
        const userRect = user.getBoundingClientRect();
        return {
          listWidth: listRect.width,
          centered: Math.abs((listRect.left + listRect.right) / 2 - (main.left + main.right) / 2),
          contentWidth: contentRight - contentLeft,
          longWidth: longRect.width,
          longLeft: Math.abs(longRect.left - contentLeft),
          shortWidth: shortRect.width,
          userWidth: userRect.width,
          userRight: Math.abs(userRect.right - contentRight),
          composerLeft: Math.abs(composer.left - listRect.left),
          composerRight: Math.abs(composer.right - listRect.right),
          borders: ['Top', 'Right', 'Bottom', 'Left'].map((side) =>
            parseFloat(getComputedStyle(longAnswer)['border' + side + 'Width'])),
          background: getComputedStyle(longAnswer).backgroundColor,
          quoteBorder: parseFloat(getComputedStyle(quote).borderLeftWidth),
          codeOverflows: code.scrollWidth > code.clientWidth,
          tableOverflows: table.scrollWidth > table.clientWidth,
          codeWidth: code.getBoundingClientRect().width,
          tableWidth: table.getBoundingClientRect().width,
          historyOverflow: history.scrollWidth - history.clientWidth,
          scrollbarWidth: history.offsetWidth - history.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert.ok(layout.listWidth <= 1002, 'The centered thread must stay near the requested 1000px maximum');
      assert.ok(layout.centered <= layout.scrollbarWidth / 2 + 1 &&
        layout.composerLeft <= layout.scrollbarWidth + 1 && layout.composerRight <= layout.scrollbarWidth + 1,
        'The composer and conversation should share a centered composition: ' + JSON.stringify(layout));
      assert.ok(layout.longLeft <= 1 && layout.longWidth >= layout.contentWidth * .94 &&
        layout.longWidth <= layout.contentWidth + 1, 'Long model text should use the thread width: ' + JSON.stringify(layout));
      assert.ok(layout.shortWidth < layout.contentWidth * .75, 'Short model answers should retain their intrinsic width');
      assert.ok(layout.userRight <= 1 && layout.userWidth < layout.contentWidth * .85,
        'Short user messages should stay compact and right-aligned');
      assert.deepEqual(layout.borders, [0, 0, 0, 0], 'Model answers have no decorative container borders');
      assert.ok(['rgba(0, 0, 0, 0)', 'transparent'].includes(layout.background));
      assert.ok(layout.quoteBorder > 0, 'Real Markdown quotes retain their own vertical rule');
      assert.ok(layout.codeOverflows && layout.tableOverflows && layout.codeWidth <= layout.contentWidth + 1 &&
        layout.tableWidth <= layout.contentWidth + 1, 'Code/table overflow must remain inside its block');
      assert.ok(layout.historyOverflow <= 1 && layout.pageOverflow <= 1, 'The window and history must not scroll horizontally');
      await ui(() => {
        const answers = document.querySelectorAll('.message.assistant');
        answers.item(answers.length - 2).scrollIntoView({ block: 'start' });
      });
      await capture(captureName);
    }
    await resize(originalSize);
  }

  async function checkChatGeneration(primary, backup, manual) {
    await updateConnectionGeneration(backup, '0.8', '4096');
    const chatA = await namedChat(parameterChatA);
    assert.equal(chatA.temperatureOverride, null);
    assert.equal(chatA.maxTokensOverride, null);
    await requestGenerationParameters(0.8, 4096);
    await setChatGeneration('0', '8192');
    await requestGenerationParameters(0, 8192);

    const chatB = await namedChat(parameterChatB);
    assert.equal(chatB.temperatureOverride, null);
    assert.equal(chatB.maxTokensOverride, null);
    await requestGenerationParameters(0.8, 4096);
    await updateConnectionGeneration(backup, '0.9', '2048');
    await requestGenerationParameters(0.9, 2048);
    await click(`.chat-name[title="${parameterChatA}"]`);
    await until('select parameter chat A', async () => (await read()).chat.id === chatA.id);
    await requestGenerationParameters(0, 8192);
    await applyChatProvider(primary.id);
    assert.equal((await read()).chat.temperatureOverride, 0);
    assert.equal((await read()).chat.maxTokensOverride, 8192);
    await requestGenerationParameters(0, 8192, deepSeekKey);
    await setChatGeneration('', '8192');
    await requestGenerationParameters(0.6, 8192, deepSeekKey);
    await setChatGeneration('', '');
    await requestGenerationParameters(0.6, undefined, deepSeekKey);
    await applyChatProvider(manual.id);
    await requestGenerationParameters(undefined, undefined, customKey);
    await checkConversationGeometry();
    await removeCurrentChat();
    await click(`.chat-name[title="${parameterChatB}"]`);
    await until('select parameter chat B', async () => (await read()).chat.id === chatB.id);
    assert.equal((await read()).chat.temperatureOverride, null);
    assert.equal((await read()).chat.maxTokensOverride, null);
    await removeCurrentChat();
    await updateConnectionGeneration(backup, '', '40');
  }

  async function checkMarkdown() {
    const rendererErrors = [];
    const recordError = (details) => { if (details.level === 'error') rendererErrors.push(details.message); };
    win.webContents.on('console-message', recordError);
    const release = Promise.withResolvers();
    scriptedReplies.push(() => stream(markdownStart, { continuation: markdownContinuation, release: release.promise }));
    const assistant = '.assistant .message-text';
    await send(markdownPrompt);
    try {
      await until('an unfinished code block is rendered during generation', () => ui((selector, line) =>
        document.querySelector(selector + ' pre code')?.textContent.includes(line), assistant, codeFirstLine));
      const partial = await read();
      assert.equal(partial.running?.chatId, partial.chat.id);
      assert.equal(partial.chat.messages.at(-1).text, markdownStart);
      assert.ok(await box('.stop'));
    } finally {
      release.resolve();
    }
    await waitForReply();
    await until('the completed Markdown table renders', () => box(assistant + ' table'));
    const stored = (await read()).chat.messages;
    assert.deepEqual(stored.map(({ role, text }) => [role, text]),
      [['user', markdownPrompt], ['assistant', markdownReply]]);

    const rendered = await ui((selector) => {
      const message = document.querySelector(selector);
      const pre = message.querySelector('pre');
      return {
        title: message.querySelector('h2')?.textContent,
        strong: message.querySelector('strong')?.textContent,
        emphasis: message.querySelector('em')?.textContent,
        strike: message.querySelector('del')?.textContent,
        unordered: [...message.querySelectorAll('ul li')].map(({ textContent }) => textContent),
        ordered: [...message.querySelectorAll('ol li')].map(({ textContent }) => textContent),
        quote: message.querySelector('blockquote')?.textContent.trim(),
        separator: Boolean(message.querySelector('hr')),
        lineBreaks: [...message.querySelectorAll('p')].some((paragraph) =>
          paragraph.innerText === 'Первая строка\nВторая строка' && paragraph.querySelector('br')),
        inlineCode: message.querySelector('p code')?.textContent,
        code: pre.querySelector('code').textContent.replace(/\n$/, ''),
        language: message.querySelector('.markdown-code-language')?.textContent,
        codeOverflows: pre.scrollWidth > pre.clientWidth,
        table: [...message.querySelectorAll('table tr')].map((row) => [...row.cells].map(({ textContent }) => textContent)),
        links: [...message.querySelectorAll('a[href]')].map((link) => [link.textContent, link.href]),
        unsafeMarkup: Boolean(message.querySelector('script, img, #raw-markdown-html, [onclick], [onerror]')),
        executedScript: document.body.dataset.markdownProbe ?? null,
      };
    }, assistant);
    assert.deepEqual(rendered, {
      title: 'Ответ Markdown', strong: 'Жирное', emphasis: 'курсив', strike: 'зачёркивание',
      unordered: ['Первый пункт', 'Второй пункт'], ordered: ['Номер один', 'Номер два'],
      quote: 'Цитата', separator: true, lineBreaks: true, inlineCode: 'inline()',
      code: markdownCode, language: 'javascript', codeOverflows: true,
      table: [['Столбец', 'Значение'], ['Код', '2']],
      links: [['Документация', markdownLink]], unsafeMarkup: false, executedScript: null,
    });
    assert.equal(await ui(() => document.querySelector('.user .message-text h1').textContent), 'Вопрос в Markdown');
    assert.equal(await ui(() => document.querySelector('.user .message-text strong').textContent), 'Важный');
    assert.deepEqual(await ui(() => performance.getEntriesByType('resource')
      .map(({ name }) => name).filter((name) => name.startsWith('https://example.test/'))), []);

    await button('Copy code', '.assistant button');
    await until('code block clipboard confirmation', () => box('button[aria-label="Code copied"]'));
    assert.equal((await clipboard.readText()).replaceAll('\r\n', '\n'), markdownCode);
    await button('Copy', '.assistant .message-actions button');
    await until('raw Markdown clipboard confirmation', () => box('.assistant .message-actions button[aria-label="Copied"]'));
    assert.equal((await clipboard.readText()).replaceAll('\r\n', '\n'), markdownReply);
    await button('Edit', '.assistant .message-actions button');
    assert.equal(await ui(() => document.querySelector('dialog[open] textarea').value), markdownReply);
    await button('Cancel', 'dialog[open] button');

    const unsafeLinks = ['file:///D:/secret.txt', 'javascript:alert(1)', 'http://example.test',
      'https://user:pass@example.test', 'https:\\example.test', 17];
    const denied = await ui((links) => Promise.all(links.map((link) => window.feinchat.openLink(link))), unsafeLinks);
    assert.ok(denied.every((result) => result.ok === false), 'The main process must reject unsafe URLs');
    const linkSelector = assistant + ' a[href]';
    await click(linkSelector);
    await settle();
    assert.deepEqual(externalLinks, [], 'Scripted clicks cannot launch the browser');
    const beforeLink = win.webContents.getURL();
    await ui((selector) => document.querySelector(selector).scrollIntoView({ block: 'center' }), linkSelector);
    await settle();
    await pointerClick(linkSelector);
    await until('the clicked HTTPS link reaches the browser launcher', () => externalLinks.length > 0);
    assert.deepEqual(externalLinks, [markdownLink]);
    assert.equal(win.webContents.getURL(), beforeLink, 'External links must not navigate the chat window');
    await ui((selector) => document.querySelector(selector + ' h2').scrollIntoView({ block: 'start' }), assistant);
    await capture('markdown');
    await ui((selector) => document.querySelector(selector + ' pre').scrollIntoView({ block: 'center' }), assistant);
    await capture('markdown-code');
    win.webContents.off('console-message', recordError);
    assert.deepEqual(rendererErrors, []);
    await checkLayout();
  }

  async function checkMessageEdits() {
    const edits = '.user .message-actions button';
    const assistantActions = '.assistant .message-actions button';
    const save = 'dialog[open] button[type="submit"]';
    const reply = '.send[aria-label="Get response"]';
    const messages = async () => (await read()).chat.messages;
    const first = (await messages())[0];
    let previous = calls.length;
    await button('Delete', assistantActions);
    await button('Delete', 'dialog[open] button');
    await until('deletion leaves a user message awaiting a reply', () => box(reply + ':enabled'));
    assert.deepEqual(await messages(), [first]);
    assert.equal(calls.length, previous);
    assert.ok(await ui(() => !document.body.innerText.includes('Get a response to the last message')));

    async function generate(action) {
      const before = calls.length;
      await action();
      const request = await until('a single request starts', () => calls[before]);
      await waitForReply();
      await until('Send button returns after generation', () => box('.send'));
      assert.equal(calls.length, before + 1);
      return request.data.messages;
    }
    assert.deepEqual(await generate(() => click(reply)), [{ role: 'user', content: markdownPrompt }]);
    assert.deepEqual((await messages()).filter(({ role }) => role === 'user'), [first]);
    previous = calls.length;
    assert.equal(await ui(() => document.querySelector('.send').disabled), true);
    await ui(() => document.querySelector('.compose-row').requestSubmit());
    await settle();
    assert.equal(calls.length, previous, 'An existing answer prevents sending an empty composer');

    await generate(() => send('Следующий вопрос'));
    await button('Delete', '.assistant:last-child .message-actions button');
    await button('Delete', 'dialog[open] button');
    await until('latest user message becomes the last row', async () => (await messages()).at(-1).role === 'user');
    const latest = (await messages()).at(-1);
    await button('Edit', '.user:last-child .message-actions button');
    assert.equal(await ui((selector) => document.querySelector(selector).disabled, save), true);
    assert.equal(await ui(() => document.querySelector('dialog[open]').innerText
      .includes('All messages after the selected message will be permanently deleted')), false);
    assert.equal(calls.length, previous + 1, 'An unchanged edit has no API request');
    const latestRevision = '**Последний вопрос исправлен**.';
    await input('dialog[open] textarea', latestRevision);
    const stoppedText = 'Частичный ответ на исправленный вопрос.';
    aborted = false;
    scriptedReplies.push(({ signal }) => stream(stoppedText, { signal, stop: true }));
    await button('Save and get response', 'dialog[open] button');
    await content(stoppedText);
    await click('.stop');
    await until('Stop aborts the edited message request', () => aborted);
    await waitForReply();
    await until('Send button returns after Stop', () => box('.send'));
    let current = await messages();
    assert.deepEqual(current.filter(({ role }) => role === 'user').map(({ id, text }) => [id, text]),
      [[first.id, first.text], [latest.id, latestRevision]]);
    assert.equal(current.at(-1).text, stoppedText);
    assert.equal(current.at(-1).status, 'stopped');
    assert.equal(await ui(() => document.querySelector('.send').disabled), true, 'A partial answer must block empty retry');

    await button('Edit', edits);
    await content('All messages after the selected message will be permanently deleted');
    await input('dialog[open] textarea', revisedPrompt);
    previous = calls.length;
    await button('Cancel', 'dialog[open] button');
    assert.deepEqual(await messages(), current);
    assert.equal(calls.length, previous);

    await button('Edit', edits);
    await content('All messages after the selected message will be permanently deleted');
    await input('dialog[open] textarea', revisedPrompt);
    scriptedReplies.push(() => Response.json({ error: { message: 'Ошибка после правки' } }, { status: 503 }));
    const context = await generate(() => ui((selector) => {
      const submit = document.querySelector(selector);
      submit.click();
      submit.click();
    }, save));
    assert.deepEqual(context, [{ role: 'user', content: revisedPrompt }]);
    await content('HTTP 503');
    current = await messages();
    assert.deepEqual(current.map(({ role, text }) => [role, text]), [['user', revisedPrompt], ['assistant', '']]);
    assert.equal(current[0].id, first.id);
    assert.equal(current[1].status, 'failed');
    await until('an empty failed answer can be retried', () => box(reply + ':enabled'));
    assert.deepEqual(await generate(() => click(reply)), [{ role: 'user', content: revisedPrompt }]);
    current = await messages();
    assert.equal(current.length, 2);
    assert.equal(current[0].id, first.id);
    const finalAnswerId = current[1].id;

    previous = calls.length;
    await button('Edit', assistantActions);
    await input('dialog[open] textarea', manualReply);
    await button('Save', 'dialog[open] button');
    await until('manual assistant edit renders Markdown', () => box('.assistant .message-text h3'));
    current = await messages();
    assert.equal(current[1].id, finalAnswerId);
    assert.equal(current[1].text, manualReply);
    assert.equal(calls.length, previous, 'Editing a model answer must not request generation');
  }
  async function checkMenuAtEdge() {
    await resize(win.getMinimumSize());
    for (let count = 1; count <= 18; count++) {
      await click('.new-chat');
      await until('added chat ' + count, () => ui((expected) => document.querySelectorAll('.chat-row').length === expected, count));
    }
    await pointerClick('.chats > :first-child .chat-menu');
    await button('Rename', `${popup} button`);
    await ui(() => document.querySelector('dialog input').setSelectionRange(0, 0));
    key('A', ['control']);
    await until('Ctrl+A selects the editable chat name', () => ui(() => {
      const name = document.querySelector('dialog input');
      return name.selectionStart === 0 && name.selectionEnd === name.value.length;
    }));
    const longName = 'Длинное название чата '.repeat(5).trimEnd();
    await input('dialog input', longName);
    await button('Save', 'dialog button');
    await until('long chat name is applied', () => ui((name) => document.querySelector('.topbar h1').textContent === name, longName));
    const titleLayout = await ui(() => {
      const title = document.querySelector('.chat-row.selected .chat-title');
      const list = document.querySelector('.chats');
      return {
        title: title.scrollWidth, available: title.clientWidth, tooltip: title.closest('.chat-name').title,
        list: list.scrollWidth, listAvailable: list.clientWidth, page: document.documentElement.scrollWidth, window: innerWidth,
      };
    });
    assert.equal(titleLayout.tooltip, longName);
    assert.ok(titleLayout.title > titleLayout.available && titleLayout.list <= titleLayout.listAvailable + 1 &&
      titleLayout.page <= titleLayout.window, 'Long chat names should be truncated inside the sidebar: ' + JSON.stringify(titleLayout));
    await checkLayout();
    assert.ok(await ui(() => {
      const list = document.querySelector('.chats');
      list.scrollTop = list.scrollHeight;
      return list.scrollHeight > list.clientHeight;
    }), 'Long chat list should scroll independently');
    await settle();

    const trigger = '.chats > :last-child .chat-menu';
    const rowPositions = () => ui(() => [...document.querySelectorAll('.chat-row')].map((row) => row.getBoundingClientRect().top));
    const before = await rowPositions();
    await pointerClick(trigger);
    await until('chat menu opens near the bottom edge', () => box(popup));
    assert.deepEqual(await rowPositions(), before, 'Opening the popup must not move neighboring chat rows');
    const menu = await box(popup);
    const viewport = await ui(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(menu.left >= 0 && menu.top >= 0 && menu.right <= viewport.width && menu.bottom <= viewport.height,
      'Chat menu should fit within the viewport');
    for (let i = 1; i <= 4; i++) await visiblePoint(`${popup} button:nth-of-type(${i})`);
    await capture('chat-menu-compact');

    key('Escape');
    await until('Escape dismisses the chat menu', async () => !(await box(popup)));
    assert.equal(await ui((matches) => document.activeElement.matches(matches), trigger), true);
    await pointerClick(trigger);
    await until('chat menu reopens', () => box(popup));
    await pointerClick('.topbar h1');
    await until('an outside click dismisses the chat menu', async () => !(await box(popup)));
    await pointerClick(trigger);
    await until('chat menu reopens before scrolling', () => box(popup));
    await ui(() => { document.querySelector('.chats').scrollTop = 0; });
    await until('scrolling the chat list dismisses its menu', async () => !(await box(popup)));
  }

  await until('loaded React', () => !win.webContents.isLoadingMainFrame() && win.webContents.getURL() &&
    ui(() => document.querySelector('.new-chat')?.disabled === false));
  await until('visible window', () => win.isVisible());
  win.focus();
  const prefs = win.webContents.getLastWebPreferences();
  assert.deepEqual([prefs.contextIsolation, prefs.nodeIntegration, prefs.sandbox], [true, false, true]);
  assert.equal(await ui(() => typeof window.require), 'undefined');
  const data = path.join(__dirname, 'data');
  for (const name of ['userData', 'sessionData', 'crashDumps', 'logs', 'temp']) {
    assert.ok(app.getPath(name).startsWith(data + path.sep), name);
  }
  assert.ok(existsSync(path.join(data, 'feinchat.sqlite3')));

  if (phase === 'exercise') {
    const initial = await read();
    assert.equal(initial.chat, null);
    assert.equal(initial.theme, 'light');
    assert.deepEqual(initial.providers, []);
    assert.equal(initial.selected.providerId, null);
    await checkLayout();
    await capture('first-launch');
    await click('.new-chat');
    await until('catalog opens for the first chat', () => box('.provider-catalog'));
    await capture('connection-catalog');
    const wideSize = win.getSize();
    await resize(win.getMinimumSize());
    await selectPreset('OpenRouter', catalog.OpenRouter);
    assert.ok(await ui(() => {
      const field = document.querySelector('input[name="apiKey"]');
      return field.type === 'password' && field.required;
    }));
    await useSetting('.provider-form button[type="submit"]');
    assert.deepEqual((await read()).providers, [], 'The first connection requires an API key');
    await input('input[name="apiKey"]', originalKey);
    await input('input[name="model"]', 'fixture/chat');
    await useSetting('.provider-form button[type="submit"]');
    const firstChat = await until('first connection creates the requested chat', async () => (await read()).chat);
    assert.equal(firstChat.model, 'fixture/chat');
    assert.equal((await read()).selected.providerId, firstChat.providerId);
    assert.equal(calls.length, 0, 'Opening and saving a connection should not send API requests');
    await until('catalog closes after first chat is created', () => ui(() => !document.querySelector('dialog[open]')));
    assert.equal(await dragText('.topbar h1'), '', 'Heading text must not be selected by dragging');
    assert.equal(await dragText('.chat-name'), '', 'Chat names must not be selected by dragging');
    await checkComposer();
    await capture('chat-compact');
    await openSettings();
    await capture('settings-compact');
    await pointerClick('button[aria-label="Close settings"]');
    await resize(wideSize);
    await chatActions('New chat');
    await button('Rename');
    await input('dialog input', 'Основной чат');
    await button('Save', 'dialog button');
    await chatActions('Основной чат');
    await button('Pin');

    await send(firstPrompt);
    await content(firstFragment);
    await until('Stop while streaming', () => ui(() => Boolean(document.querySelector('.stop'))));
  } else {
    const restored = await read();
    assert.equal(restored.chat.name, markdownChat);
    assert.equal(restored.chat.temperatureOverride, 0);
    assert.equal(restored.chat.maxTokensOverride, 8192);
    assert.deepEqual(restored.chat.messages.map(({ role, text }) => [role, text]),
      [['user', revisedPrompt], ['assistant', manualReply]]);
    assert.equal(await ui(() => document.querySelector('.user .message-text h2').textContent), 'Исправленный вопрос');
    assert.equal(await ui(() => document.querySelector('.assistant .message-text h3').textContent), 'Ручной ответ');
    assert.equal(calls.length, 0, 'Restarting with a saved conversation must not start a generation');
    await chatActions(markdownChat);
    await button('Delete', '.chat-actions button');
    await button('Delete', 'dialog button');
    await until('original chat is selected after fixture removal', async () => (await read()).chat.name === 'Основной чат');
    const state = await read();
    assert.equal(state.theme, 'dark');
    assert.equal(await ui(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(state.chat.name, 'Основной чат');
    assert.equal(state.chats[0].pinned, 1);
    assert.equal(state.selected.providerId, 3);
    assert.equal(state.chat.providerId, 2);
    assert.equal(state.chat.model, 'fixture/deepseek-override');
    assert.equal(state.providers[0].model, 'fixture/chat');
    assert.equal(state.providers[0].hasKey, 1);
    assert.equal(state.providers.length, 4);
    assert.equal(state.chat.messages.length, 6);
    assert.equal(state.chat.messages[3].status, 'stopped');
    assert.equal(state.chat.messages[3].text, 'Сохранённая часть.');
    assert.equal(state.chat.usage.costs[0].amount, 0.004);
    await content('Ответ второго провайдера.');

    await button('Edit', '.assistant button');
    await content('All messages after the selected message will be permanently deleted');
    await button('Cancel', 'dialog button');
    assert.equal((await read()).chat.messages.length, 6);
    await button('Edit', '.assistant button');
    await input('dialog textarea', 'Исправленный ответ');
    await button('Save and delete later messages');
    await content('Исправленный ответ');
    assert.equal((await read()).chat.messages.length, 2);
    await button('Delete', '.user button');
    await content('All messages after the selected message will be permanently deleted');
    await button('Delete', 'dialog button');
    await until('chat history is empty', async () => (await read()).chat.messages.length === 0);
    assert.equal(calls.length, 0, 'Deleting messages and editing a model answer must not call the API');
    await chatActions('Основной чат');
    await button('Delete', '.chat-actions button');
    await button('Delete', 'dialog button');
    await until('chat is deleted', async () => (await read()).chats.length === 0);
    await checkMenuAtEdge();
    return;
  }

  await content(firstContinuation.trim());
  await waitForReply();
  await checkLayout();
  assert.equal(await ui(() => document.querySelector('.topbar').textContent.includes('0.004 USD')), false);
  assert.match(await dragText('.assistant .message-text'), /ривет/u);
  await button('Copy', '.assistant button');
  await until('copy confirmation', () => ui(() => Boolean(document.querySelector('.assistant button[aria-label="Copied"]'))));
  assert.equal((await clipboard.readText()).replaceAll('\r\n', '\n'), firstReply);
  assert.deepEqual(calls[0], { url: openRouter, key: originalKey,
    data: { model: 'fixture/chat', stream: true, messages: [{ role: 'user', content: firstPrompt }] } });
  await ui(() => window.getSelection().removeAllRanges());
  await capture('chat-light');
  await switchTheme('dark');
  await capture('chat-dark');
  await switchTheme('light');
  await switchTheme('dark');
  await openChatParameters('Основной чат');
  assert.ok(await ui(() => !document.querySelector('.chat-settings-form select')), 'A single connection needs no selector');
  assert.equal(await ui(() => document.querySelector('.chat-settings-form input[name="model"]').value), 'fixture/chat');
  const usage = await ui(() => Array.from(document.querySelectorAll('.chat-usage div'), (stat) =>
    [stat.querySelector('dt')?.textContent, stat.querySelector('dd')?.textContent]));
  assert.deepEqual(usage, [['Input tokens', '7'], ['Output tokens', '5'],
    ['Total tokens', '12'], ['Total cost', '0.004 USD']]);
  await capture('chat-parameters');
  await closeSettings();

  await send('Остановить ответ');
  await content('Сохранённая часть.');
  await click('.new-chat');
  await content('A response is being generated in another chat.');
  await click('.stop');
  await until('AbortSignal', () => aborted);
  await chatActions('New chat');
  await button('Delete', '.chat-actions button');
  await button('Delete', 'dialog button');
  await content('Stopped');
  assert.deepEqual(calls[1].data.messages.map(({ content }) => content),
    [firstPrompt, firstReply, 'Остановить ответ']);

  await openSettings();
  const { primary, backup, manual } = await checkCatalog();
  await capture('settings');
  await closeSettings();
  await applyChatProvider(primary.id, 'fixture/deepseek-override');
  await send('Третий вопрос');
  await content('HTTP 429');
  await button('Regenerate', '.assistant:last-child button');
  await content('Ответ второго провайдера.');
  await waitForReply();
  assert.equal(calls[2].url, deepSeek);
  assert.equal(calls[3].url, deepSeek);
  assert.equal(calls[3].key, deepSeekKey);
  assert.equal(calls[3].data.model, 'fixture/deepseek-override');
  assert.equal(calls[3].data.temperature, 0.6);
  assert.equal(calls[3].data.max_tokens, undefined);
  assert.deepEqual(calls[3].data.messages.map(({ content }) => content),
    [firstPrompt, firstReply, 'Остановить ответ', 'Сохранённая часть.', 'Третий вопрос']);

  await button('Regenerate', '.assistant button');
  await content('All messages after the selected message will be permanently deleted');
  await button('Cancel', 'dialog button');
  assert.equal((await read()).chat.messages.length, 6);

  await click('.new-chat');
  await until('new chat uses the default connection', async () => (await read()).chat.providerId === backup.id);
  const newChat = (await read()).chat;
  await openChatParameters('Основной чат');
  assert.equal((await read()).chat.id, newChat.id, 'Opening parameters for another chat should keep the selected chat');
  assert.equal(await ui(() => document.querySelector('.chat-settings-form input[name="model"]').value), 'fixture/deepseek-override');
  await closeSettings();
  for (const [providerId, url, key, model, limit] of [
    [backup.id, deepSeek, backupKey, backup.model, 40],
    [manual.id, custom, customKey, manual.model, undefined],
    [1, openRouter, originalKey, 'fixture/chat', undefined],
  ]) {
    if (providerId !== backup.id) await applyChatProvider(providerId);
    const callCount = calls.length;
    await send('Проверка подключения ' + providerId);
    await until('request to ' + url, () => calls.length > callCount);
    await waitForReply();
    const request = calls[callCount];
    assert.equal(request.url, url);
    assert.equal(request.key, key);
    assert.equal(request.data.model, model);
    assert.equal(request.data.max_tokens, limit);
    assert.equal(request.data.temperature, undefined);
  }
  await chatActions('New chat');
  await button('Delete', '.chat-actions button');
  await button('Delete', 'dialog button');
  await until('original chat is restored', async () => (await read()).chat.name === 'Основной чат');

  await checkChatGeneration(primary, backup, manual);
  await click('.new-chat');
  await until('markdown test chat is created', async () => (await read()).chat.name === 'New chat');
  await chatActions('New chat');
  await button('Rename', '.chat-actions button');
  await input('dialog[open] input', markdownChat);
  await button('Save', 'dialog[open] button');
  await until('markdown test chat is named', async () => (await read()).chat.name === markdownChat);
  await setChatGeneration('0', '8192');
  await checkMarkdown();
  await checkMessageEdits();
  console.log('Desktop chat, themes, provider catalog, streaming, Stop, Markdown, edited messages, and retries passed.');
}

run(process.argv.at(-1)).then(() => {
  console.log('Desktop ' + process.argv.at(-1) + ' passed.');
  BrowserWindow.getAllWindows()[0].close();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
