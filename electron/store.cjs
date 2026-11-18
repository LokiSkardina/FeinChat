const { DatabaseSync } = require('node:sqlite');
const { MAX_CONTEXT, requireInput } = require('./input.cjs');

function openStore(filename) {
  const db = new DatabaseSync(filename);
  const statements = new Map();
  const query = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    transaction(() => {
      const version = query('PRAGMA user_version').get().user_version;
      requireInput(version <= 3, 'The database was created by a newer version of FeinChat.');
      if (version === 0) {
        db.exec(`
          CREATE TABLE providers (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            baseUrl TEXT NOT NULL,
            apiKey TEXT NOT NULL,
            model TEXT NOT NULL,
            temperature REAL,
            maxTokens INTEGER
          ) STRICT;
          CREATE TABLE chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
            updatedAt INTEGER NOT NULL,
            providerId INTEGER NOT NULL REFERENCES providers(id),
            baseUrl TEXT NOT NULL,
            model TEXT NOT NULL,
            temperature REAL,
            maxTokens INTEGER
          ) STRICT;
          CREATE TABLE preferences (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            providerId INTEGER NOT NULL REFERENCES providers(id),
            chatId INTEGER REFERENCES chats(id) ON DELETE SET NULL
          ) STRICT;
          CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chatId INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            text TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('done', 'streaming', 'stopped', 'failed', 'interrupted')),
            error TEXT
          ) STRICT;
          CREATE INDEX messages_chat ON messages(chatId, id);
          CREATE TABLE requests (
            id INTEGER PRIMARY KEY,
            chatId INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            endpoint TEXT NOT NULL,
            inputTokens INTEGER,
            outputTokens INTEGER,
            totalTokens INTEGER,
            cost REAL,
            currency TEXT
          ) STRICT;
          CREATE INDEX requests_chat ON requests(chatId);
        `);
      }
      if (version < 2) {
        db.exec(`
          CREATE TABLE appearance (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            theme TEXT NOT NULL CHECK (theme IN ('light', 'dark'))
          ) STRICT;
          INSERT INTO appearance (id, theme) VALUES (1, 'light');
          PRAGMA user_version = 2;
        `);
      }
      if (version < 3) {
        db.exec(`
          ALTER TABLE chats ADD COLUMN temperatureOverride REAL;
          ALTER TABLE chats ADD COLUMN maxTokensOverride INTEGER;
          PRAGMA user_version = 3;
        `);
      }
      query("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'").run();
    });
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  } catch (error) {
    db.close();
    throw error;
  }

  const provider = (id) => query('SELECT * FROM providers WHERE id = ?').get(id);
  const theme = () => query('SELECT theme FROM appearance WHERE id = 1').get().theme;
  const setDefaultProvider = (id) => query(`
    INSERT INTO preferences (id, providerId) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET providerId = excluded.providerId
  `).run(id);

  function preferences() {
    const saved = query(`
      SELECT COALESCE(
        (SELECT id FROM providers WHERE id = preferences.providerId AND apiKey <> ''),
        (SELECT id FROM providers WHERE apiKey <> '' ORDER BY id LIMIT 1),
        providerId
      ) AS providerId, chatId FROM preferences WHERE id = 1
    `).get();
    return saved ?? { providerId: null, chatId: null };
  }

  const chat = (id) => query(`
    SELECT chats.*, providers.name AS providerName FROM chats
    JOIN providers ON providers.id = chats.providerId WHERE chats.id = ?
  `).get(id);
  const selectChat = (id) => query('UPDATE preferences SET chatId = ? WHERE id = 1').run(id);
  const touch = (id) => query('UPDATE chats SET updatedAt = ? WHERE id = ?').run(Date.now(), id);
  const tail = (id) => query('SELECT * FROM messages WHERE chatId = ? ORDER BY id DESC LIMIT 1').get(id);
  const message = (chatId, id) => query('SELECT * FROM messages WHERE chatId = ? AND id = ?').get(chatId, id);

  function usage(chatId) {
    const totals = query(`
      SELECT COUNT(*) AS requests, SUM(inputTokens) AS inputTokens, COUNT(inputTokens) AS inputKnown,
        SUM(outputTokens) AS outputTokens, COUNT(outputTokens) AS outputKnown,
        SUM(totalTokens) AS totalTokens, COUNT(totalTokens) AS totalKnown, COUNT(cost) AS costKnown
      FROM requests WHERE chatId = ?
    `).get(chatId);
    const costs = query(`
      SELECT currency, CASE WHEN currency IS NULL THEN endpoint END AS host, SUM(cost) AS amount
      FROM requests WHERE chatId = ? AND cost IS NOT NULL GROUP BY currency, host ORDER BY currency, host
    `).all(chatId);
    return { ...totals, costs };
  }

  function snapshot() {
    const selected = preferences();
    const chats = query('SELECT id, name, pinned FROM chats ORDER BY pinned DESC, updatedAt DESC, id DESC').all();
    const providers = query(`
      SELECT id, name, baseUrl, model, temperature, maxTokens, length(apiKey) > 0 AS hasKey
      FROM providers ORDER BY id
    `).all();
    const details = selected.chatId === null ? null : {
      ...chatDetails(selected.chatId),
      messages: query('SELECT * FROM messages WHERE chatId = ? ORDER BY id').all(selected.chatId),
    };
    return { chats, providers, selected, theme: theme(), chat: details };
  }

  function chatDetails(id) {
    const summary = chat(id);
    return summary ? { ...summary, usage: usage(id) } : null;
  }

  function saveProvider(config) {
    return transaction(() => {
      const hasConfigured = Boolean(query("SELECT 1 FROM providers WHERE apiKey <> '' LIMIT 1").get());
      if (config.id === null) {
        requireInput(config.apiKey, 'Enter an API key for the new connection.');
        const result = query(`
          INSERT INTO providers (name, baseUrl, apiKey, model, temperature, maxTokens) VALUES (?, ?, ?, ?, ?, ?)
        `).run(config.name, config.baseUrl, config.apiKey, config.model, config.temperature, config.maxTokens);
        if (!hasConfigured) setDefaultProvider(result.lastInsertRowid);
        return result.lastInsertRowid;
      }
      const previous = provider(config.id);
      requireInput(previous, 'Connection not found.');
      const sameHost = new URL(previous.baseUrl).origin === new URL(config.baseUrl).origin;
      const apiKey = config.clearKey ? '' : config.apiKey || (sameHost ? previous.apiKey : '');
      query(`
        UPDATE providers SET name = ?, baseUrl = ?, apiKey = ?, model = ?, temperature = ?, maxTokens = ?
        WHERE id = ?
      `).run(config.name, config.baseUrl, apiKey, config.model, config.temperature, config.maxTokens, config.id);
      if (apiKey && !hasConfigured) setDefaultProvider(config.id);
      return config.id;
    });
  }

  function createChat() {
    return transaction(() => {
      const { providerId } = preferences();
      requireInput(providerId !== null, 'Add an API connection first.');
      const active = provider(providerId);
      const result = query(`
        INSERT INTO chats (name, updatedAt, providerId, baseUrl, model, temperature, maxTokens)
        VALUES ('New chat', ?, ?, ?, ?, ?, ?)
      `).run(Date.now(), active.id, active.baseUrl, active.model, active.temperature, active.maxTokens);
      selectChat(result.lastInsertRowid);
    });
  }

  function deleteChat(id) {
    transaction(() => {
      const selected = preferences().chatId;
      query('DELETE FROM chats WHERE id = ?').run(id);
      if (selected === id) {
        const next = query('SELECT id FROM chats ORDER BY pinned DESC, updatedAt DESC, id DESC LIMIT 1').get();
        selectChat(next?.id ?? null);
      }
    });
  }

  function applyProvider(chatId, providerId, model, parameters) {
    const config = provider(providerId);
    requireInput(config, 'Connection not found.');
    const current = chat(chatId);
    requireInput(current, 'Chat not found.');
    const overrides = parameters ?? {
      temperature: current.temperatureOverride,
      maxTokens: current.maxTokensOverride,
    };
    query(`
      UPDATE chats SET providerId = ?, baseUrl = ?, model = ?, temperature = ?, maxTokens = ?,
        temperatureOverride = ?, maxTokensOverride = ? WHERE id = ?
    `).run(config.id, config.baseUrl, model, config.temperature, config.maxTokens,
      overrides.temperature, overrides.maxTokens, chatId);
  }

  function requireCurrentTail(chatId, tailId) {
    const last = tail(chatId);
    requireInput((last?.id ?? null) === tailId, 'The history has changed. Try again.');
    return last;
  }

  function requireTruncationConsent(last, target, confirmed) {
    requireInput(last.id === target.id || confirmed === true, 'Confirm deletion of the subsequent history.');
  }

  function changeAndTruncate(target, replacement) {
    query('DELETE FROM messages WHERE chatId = ? AND id > ?').run(target.chatId, target.id);
    if (replacement === null) {
      query('DELETE FROM messages WHERE chatId = ? AND id = ?').run(target.chatId, target.id);
    } else {
      query("UPDATE messages SET text = ?, status = 'done', error = NULL WHERE id = ?").run(replacement, target.id);
    }
  }

  function changeMessage(chatId, messageId, tailId, confirmed, replacement) {
    transaction(() => {
      const target = message(chatId, messageId);
      requireInput(target, 'Message not found.');
      requireTruncationConsent(requireCurrentTail(chatId, tailId), target, confirmed);
      if (replacement !== null && target.text === replacement) return;
      changeAndTruncate(target, replacement);
      touch(chatId);
    });
  }

  function beginGeneration(config, command) {
    return transaction(() => {
      const chatId = config.id;
      const last = requireCurrentTail(chatId, command.tailId);
      const append = query('INSERT INTO messages (chatId, role, text, status) VALUES (?, ?, ?, ?)');
      if (command.mode === 'send') {
        append.run(chatId, 'user', command.text, 'done');
      } else if (command.mode === 'edit') {
        const target = message(chatId, command.messageId);
        requireInput(target?.role === 'user', 'User message not found.');
        if (target.text === command.text) return null;
        requireTruncationConsent(last, target, command.confirmed);
        changeAndTruncate(target, command.text);
      } else if (command.mode === 'regenerate') {
        const target = message(chatId, command.messageId);
        requireInput(target?.role === 'assistant', 'The response to regenerate was not found.');
        requireTruncationConsent(last, target, command.confirmed);
        query('DELETE FROM messages WHERE chatId = ? AND id >= ?').run(chatId, target.id);
      } else {
        requireInput(last?.role === 'user', 'The chat must end with a user message.');
      }
      const context = query(`
        SELECT role, text AS content FROM messages
        WHERE chatId = ? AND length(trim(text)) > 0 ORDER BY id
      `).all(chatId);
      requireInput(context.some((item) => item.role === 'user'), 'A user message is required for the request.');
      requireInput(context.reduce((size, item) => size + item.content.length, 0) <= MAX_CONTEXT,
        'The history exceeds the local request size limit. Shorten it or open a new chat.');
      const messageId = append.run(chatId, 'assistant', '', 'streaming').lastInsertRowid;
      const requestId = query('INSERT INTO requests (chatId, endpoint) VALUES (?, ?)')
        .run(chatId, new URL(config.baseUrl).host).lastInsertRowid;
      touch(chatId);
      return { context, messageId, requestId };
    });
  }

  function saveProgress(messageId, text) {
    query("UPDATE messages SET text = ? WHERE id = ? AND status = 'streaming'").run(text, messageId);
  }

  function finishGeneration(job, status, error) {
    transaction(() => {
      const { inputTokens = null, outputTokens = null, totalTokens = null, cost = null, currency = null } = job.usage;
      query('UPDATE messages SET text = ?, status = ?, error = ? WHERE id = ?')
        .run(job.text, status, error, job.messageId);
      query(`
        UPDATE requests SET inputTokens = ?, outputTokens = ?, totalTokens = ?, cost = ?, currency = ? WHERE id = ?
      `).run(inputTokens, outputTokens, totalTokens, cost, currency, job.requestId);
    });
  }

  return {
    snapshot, provider, chat, chatDetails, createChat, selectChat, deleteChat, saveProvider, applyProvider, message, changeMessage,
    beginGeneration, saveProgress, finishGeneration,
    setDefaultProvider, theme,
    setTheme: (theme) => query('UPDATE appearance SET theme = ? WHERE id = 1').run(theme),
    renameChat: (id, name) => query('UPDATE chats SET name = ? WHERE id = ?').run(name, id),
    pinChat: (id, pinned) => query('UPDATE chats SET pinned = ? WHERE id = ?').run(Number(pinned), id),
    close: () => db.close(),
  };
}

module.exports = { openStore };
