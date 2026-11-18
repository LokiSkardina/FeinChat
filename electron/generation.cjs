const { chatCompletion } = require('./api.cjs');
const { UserError, requireInput } = require('./input.cjs');

const CHECKPOINT_MS = 250;

function createGeneration(store, emit, storageError) {
  let active = null;
  let revision = 0;

  function publish(job, status, error = null) {
    emit({
      revision: ++revision,
      running: status === 'streaming' ? { chatId: job.chatId, messageId: job.messageId } : null,
      message: { id: job.messageId, chatId: job.chatId, role: 'assistant', text: job.text, status, error },
    });
  }

  function checkpoint(job) {
    if (active !== job || job.text === job.saved) return;
    try {
      store.saveProgress(job.messageId, job.text);
      job.saved = job.text;
      job.lastSavedAt = Date.now();
      publish(job, 'streaming');
    } catch {
      // A failed final save already reports the same storage failure.
      if (stopJob(job)) storageError();
    }
  }

  function onText(job, text) {
    if (active !== job) return;
    job.text += text;
    const wait = CHECKPOINT_MS - (Date.now() - job.lastSavedAt);
    if (wait <= 0) {
      clearTimeout(job.timer);
      job.timer = null;
      checkpoint(job);
    } else if (!job.timer) {
      job.timer = setTimeout(() => {
        job.timer = null;
        checkpoint(job);
      }, wait);
    }
  }

  function finish(job, status, error) {
    if (active !== job) return;
    clearTimeout(job.timer);
    active = null;
    if (status !== 'done') job.usage = {};
    try {
      store.finishGeneration(job, status, error);
      publish(job, status, error);
      return true;
    } catch {
      storageError();
      return false;
    }
  }

  function stopJob(job) {
    job.controller.abort();
    return finish(job, 'stopped', null);
  }

  async function run(job, config, messages) {
    try {
      const reason = await chatCompletion(config, messages, {
        signal: job.controller.signal,
        onText: (text) => onText(job, text),
        onUsage: (usage) => { if (active === job) Object.assign(job.usage, usage); },
      });
      finish(job, 'done', reason === 'length' ? 'The API ended the response at the token limit.' : null);
    } catch (error) {
      finish(job, 'failed', error instanceof UserError ? error.message : 'Could not receive the API response.');
    }
  }

  return {
    state: () => ({ revision, running: active && { chatId: active.chatId, messageId: active.messageId } }),
    start(config, command) {
      requireInput(!active, 'Wait for the current response to finish or press Stop.');
      const provider = store.provider(config.providerId);
      requireInput(provider.baseUrl === config.baseUrl,
        'The connection Base URL has changed. Open Chat settings and apply the connection again.');
      requireInput(provider.apiKey, 'Add an API key in Connections.');
      requireInput(config.model, 'Enter a model ID in Chat settings.');
      const request = store.beginGeneration(config, command);
      if (!request) return;
      const { context, messageId, requestId } = request;
      const job = {
        chatId: config.id, messageId, requestId, controller: new AbortController(),
        text: '', saved: '', lastSavedAt: 0, timer: null, usage: {},
      };
      active = job;
      publish(job, 'streaming');
      void run(job, {
        ...config,
        apiKey: provider.apiKey,
        temperature: config.temperatureOverride ?? provider.temperature ?? null,
        maxTokens: config.maxTokensOverride ?? provider.maxTokens ?? null,
      }, context);
    },
    stop(chatId, messageId) {
      if (active?.chatId === chatId && active.messageId === messageId) stopJob(active);
    },
    close() {
      if (active) stopJob(active);
    },
  };
}

module.exports = { createGeneration };
