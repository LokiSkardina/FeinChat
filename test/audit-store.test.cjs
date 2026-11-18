const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { openStore } = require('../electron/store.cjs');
const { MAX_CONTEXT } = require('../electron/input.cjs');

const root = path.resolve(__dirname, '..');
const temporary = path.join(root, '.cache', 'tmp');
mkdirSync(temporary, { recursive: true });

function fixture() {
  const directory = mkdtempSync(path.join(temporary, 'audit-store-'));
  return { directory, filename: path.join(directory, 'fixture.sqlite3') };
}

function configure(db) {
  const providerId = db.saveProvider({
    id: null, name: 'Audit fixture', baseUrl: 'https://fixture.example/v1', apiKey: 'audit-fixture-key',
    clearKey: false, model: 'fixture/model', temperature: 0.8, maxTokens: 4096,
  });
  db.createChat();
  const chatId = db.snapshot().chat.id;
  db.applyProvider(chatId, providerId, 'fixture/chat-model', { temperature: 0, maxTokens: 8192 });
  db.setTheme('dark');
  db.renameChat(chatId, 'Audit history');
  db.pinChat(chatId, true);
  return { chatId, providerId };
}

function integrity(filename) {
  const inspection = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.deepEqual(inspection.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check), ['ok']);
    assert.deepEqual(inspection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    inspection.close();
  }
}

function rows(db, table) {
  return JSON.parse(JSON.stringify(db.prepare('SELECT * FROM ' + table).all()));
}

function finish(db, job, text) {
  db.finishGeneration({ ...job, text, usage: {
    inputTokens: 11, outputTokens: 7, totalTokens: 18, cost: 0.04, currency: 'USD',
  } }, 'done', null);
}

test('database versions 1, 2 and 3 retain configured data when opened by the current store', () => {
  for (const version of [1, 2, 3]) {
    const { filename } = fixture();
    let db = openStore(filename);
    const { chatId } = configure(db);
    const job = db.beginGeneration(db.chat(chatId), { mode: 'send', tailId: null, text: 'Original **Markdown**\n\n> Quote' });
    finish(db, job, 'Original answer');
    db.close();
    const previous = new DatabaseSync(filename);
    let expected;
    try {
      if (version < 3) {
        previous.exec('ALTER TABLE chats DROP COLUMN temperatureOverride; ALTER TABLE chats DROP COLUMN maxTokensOverride;');
      }
      if (version < 2) previous.exec('DROP TABLE appearance');
      previous.exec('PRAGMA user_version = ' + version);
      expected = Object.fromEntries(['providers', 'chats', 'preferences', 'messages', 'requests'].map((table) => [table, rows(previous, table)]));
    } finally {
      previous.close();
    }

    db = openStore(filename);
    try {
      const current = db.snapshot();
      assert.equal(current.chat.id, chatId);
      assert.equal(current.chat.name, 'Audit history');
      assert.equal(current.chat.model, 'fixture/chat-model');
      assert.equal(current.chat.usage.totalTokens, 18);
      assert.equal(current.chat.usage.costs[0].amount, 0.04);
      assert.equal(db.provider(current.chat.providerId).apiKey, 'audit-fixture-key');
      assert.equal(current.theme, version < 2 ? 'light' : 'dark');
      assert.equal(current.chat.temperatureOverride, version < 3 ? null : 0);
      assert.equal(current.chat.maxTokensOverride, version < 3 ? null : 8192);
      const inspection = new DatabaseSync(filename, { readOnly: true });
      try {
        assert.equal(inspection.prepare('PRAGMA user_version').get().user_version, 3);
        for (const [table, old] of Object.entries(expected)) {
          const now = rows(inspection, table);
          if (table === 'chats' && version < 3) {
            assert.deepEqual(now.map(({ temperatureOverride, maxTokensOverride, ...row }) => row), old);
          } else {
            assert.deepEqual(now, old);
          }
        }
      } finally {
        inspection.close();
      }
    } finally {
      db.close();
    }
    integrity(filename);
  }
});

test('future schema versions are rejected without changing stored conversations', () => {
  const { filename } = fixture();
  const db = openStore(filename);
  const { chatId } = configure(db);
  const job = db.beginGeneration(db.chat(chatId), { mode: 'send', tailId: null, text: 'Keep this question' });
  finish(db, job, 'Keep this answer');
  db.close();
  const previous = new DatabaseSync(filename);
  let expected;
  try {
    previous.exec('PRAGMA user_version = 4');
    expected = rows(previous, 'messages');
  } finally {
    previous.close();
  }
  assert.throws(() => openStore(filename), /newer version/);
  const inspection = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(inspection.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual(rows(inspection, 'messages'), expected);
  } finally {
    inspection.close();
  }
  integrity(filename);
});

test('failed destructive history operations roll back the entire change', () => {
  const { filename } = fixture();
  const db = openStore(filename);
  try {
    const { chatId } = configure(db);
    const first = db.beginGeneration(db.chat(chatId), { mode: 'send', tailId: null, text: 'First question' });
    finish(db, first, 'First answer');
    const second = db.beginGeneration(db.chat(chatId), { mode: 'send', tailId: first.messageId, text: 'Second question' });
    finish(db, second, 'Second answer');
    const before = db.snapshot();
    const userId = before.chat.messages[0].id;
    const triggers = new DatabaseSync(filename);
    try {
      triggers.exec(`
        CREATE TRIGGER audit_reject_deletion BEFORE DELETE ON messages WHEN OLD.id = ${second.messageId}
        BEGIN SELECT RAISE(ABORT, 'Audit rejected tail deletion'); END;
      `);
      assert.throws(() => db.changeMessage(chatId, userId, second.messageId, true, 'Changed question'), /Audit rejected/);
      assert.deepEqual(db.snapshot(), before);
      assert.throws(() => db.changeMessage(chatId, userId, second.messageId, true, null), /Audit rejected/);
      assert.deepEqual(db.snapshot(), before);
      assert.throws(() => db.beginGeneration(db.chat(chatId), {
        mode: 'regenerate', tailId: second.messageId, messageId: first.messageId, confirmed: true,
      }), /Audit rejected/);
      assert.deepEqual(db.snapshot(), before);
      triggers.exec('DROP TRIGGER audit_reject_deletion');
    } finally {
      triggers.close();
    }
    assert.throws(() => db.changeMessage(chatId, userId, second.messageId, false, 'Changed question'), /Confirm/);
    assert.deepEqual(db.snapshot(), before);
    db.changeMessage(chatId, first.messageId, second.messageId, true, 'Manual assistant edit');
    assert.equal(db.snapshot().chat.messages.length, 2);
    assert.equal(db.snapshot().chat.messages[0].id, userId);
    assert.equal(db.snapshot().chat.messages[1].text, 'Manual assistant edit');
    assert.equal(db.snapshot().chat.usage.requests, 2, 'Completed attempts remain in accounting history');
    db.deleteChat(chatId);
    assert.equal(db.snapshot().chat, null);
  } finally {
    db.close();
  }
  integrity(filename);
});

test('abrupt process termination recovers committed WAL text and rolls back an uncommitted overwrite', () => {
  const { directory, filename } = fixture();
  const source = String.raw`
    const { openStore } = require('./electron/store.cjs');
    const { DatabaseSync } = require('node:sqlite');
    const db = openStore(process.argv[1]);
    const providerId = db.saveProvider({ id: null, name: 'Crash fixture', baseUrl: 'https://fixture.example/v1',
      apiKey: 'audit-fixture-key', model: 'fixture/model', temperature: null, maxTokens: null });
    db.createChat();
    const chat = db.snapshot().chat;
    const job = db.beginGeneration(chat, { mode: 'send', tailId: null, text: 'Committed question' });
    db.saveProgress(job.messageId, 'Committed partial reply');
    const pending = new DatabaseSync(process.argv[1]);
    pending.exec('BEGIN IMMEDIATE');
    pending.prepare('UPDATE messages SET text = ? WHERE id = ?').run('Uncommitted overwrite', job.messageId);
    process.kill(process.pid, 'SIGKILL');
  `;
  const result = spawnSync(process.execPath, ['-e', source, filename], {
    cwd: root,
    env: { ...process.env, TEMP: directory, TMP: directory },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'The fixture process must terminate abruptly');
  assert.equal(existsSync(filename + '-wal'), true, 'Recovery must read an actual unclosed WAL file');
  const db = openStore(filename);
  try {
    const current = db.snapshot();
    assert.deepEqual(current.chat.messages.map(({ role, text, status }) => ({ role, text, status })), [
      { role: 'user', text: 'Committed question', status: 'done' },
      { role: 'assistant', text: 'Committed partial reply', status: 'interrupted' },
    ]);
    assert.equal(current.chat.usage.requests, 1);
    assert.equal(current.chat.usage.inputKnown, 0);
    assert.equal(current.chat.usage.costKnown, 0);
  } finally {
    db.close();
  }
  integrity(filename);
});

test('failed final accounting rolls back the message update and preserves its committed checkpoint', () => {
  const { filename } = fixture();
  let db = openStore(filename);
  const { chatId } = configure(db);
  const job = db.beginGeneration(db.chat(chatId), { mode: 'send', tailId: null, text: 'Keep this question' });
  db.saveProgress(job.messageId, 'Committed partial reply');
  const before = db.snapshot();
  const triggers = new DatabaseSync(filename);
  try {
    triggers.exec(`
      CREATE TRIGGER audit_reject_accounting BEFORE UPDATE ON requests
      BEGIN SELECT RAISE(ABORT, 'Audit accounting failure'); END;
    `);
    assert.throws(() => finish(db, job, 'Unsaved final reply'), /Audit accounting failure/);
    assert.deepEqual(db.snapshot(), before, 'The failed final transaction must not leave half-applied text or usage');
    triggers.exec('DROP TRIGGER audit_reject_accounting');
  } finally {
    triggers.close();
    db.close();
  }
  db = openStore(filename);
  try {
    assert.equal(db.snapshot().chat.messages.at(-1).text, 'Committed partial reply');
    assert.equal(db.snapshot().chat.messages.at(-1).status, 'interrupted');
    assert.equal(db.snapshot().chat.usage.totalKnown, 0);
    assert.equal(db.snapshot().chat.usage.costKnown, 0);
  } finally {
    db.close();
  }
  integrity(filename);
});

test('context size rejection preserves all previous messages and their order', () => {
  const { filename } = fixture();
  const db = openStore(filename);
  try {
    const { chatId } = configure(db);
    const seed = new DatabaseSync(filename);
    try {
      const insert = seed.prepare('INSERT INTO messages (chatId, role, text, status) VALUES (?, ?, ?, ?)');
      const long = 'A'.repeat(MAX_CONTEXT / 8);
      seed.exec('BEGIN');
      for (let index = 0; index < 8; index++) insert.run(chatId, index % 2 === 0 ? 'user' : 'assistant', long, 'done');
      seed.exec('COMMIT');
    } finally {
      seed.close();
    }
    const before = db.snapshot().chat.messages;
    assert.equal(before.reduce((size, message) => size + message.text.length, 0), MAX_CONTEXT);
    assert.throws(() => db.beginGeneration(db.chat(chatId), {
      mode: 'send', tailId: before.at(-1).id, text: 'Would exceed the limit',
    }), /history exceeds/);
    assert.deepEqual(db.snapshot().chat.messages, before);
    assert.equal(db.snapshot().chat.usage.requests, 0);
  } finally {
    db.close();
  }
  integrity(filename);
});

test('100, 500 and 1000 saved messages reopen and form exact ordered context', () => {
  const results = [];
  for (const count of [100, 500, 1000]) {
    const { filename } = fixture();
    let db = openStore(filename);
    const { chatId } = configure(db);
    db.close();
    const seed = new DatabaseSync(filename);
    const expected = [];
    try {
      const insert = seed.prepare('INSERT INTO messages (chatId, role, text, status) VALUES (?, ?, ?, ?)');
      seed.exec('BEGIN');
      for (let index = 0; index < count; index++) {
        const role = index % 2 === 0 ? 'user' : 'assistant';
        const content = `Message ${index}\n\n**Source Markdown** ` + 'text '.repeat(180);
        insert.run(chatId, role, content, 'done');
        expected.push({ role, content });
      }
      seed.exec('COMMIT');
    } finally {
      seed.close();
    }
    const start = performance.now();
    db = openStore(filename);
    const reopenedAt = performance.now();
    try {
      const current = db.snapshot().chat;
      const snapshotAt = performance.now();
      assert.equal(current.messages.length, count);
      const job = db.beginGeneration(db.chat(chatId), { mode: 'send', tailId: current.messages.at(-1).id, text: 'Next question' });
      const contextAt = performance.now();
      assert.deepEqual(job.context.map((item) => ({ ...item })), [...expected, { role: 'user', content: 'Next question' }]);
      db.finishGeneration({ ...job, text: '', usage: {} }, 'stopped', null);
      results.push({
        messages: count,
        openMs: Number((reopenedAt - start).toFixed(2)),
        snapshotMs: Number((snapshotAt - reopenedAt).toFixed(2)),
        contextMs: Number((contextAt - snapshotAt).toFixed(2)),
      });
    } finally {
      db.close();
    }
    integrity(filename);
  }
  console.log('Store audit timings ' + JSON.stringify(results));
});
