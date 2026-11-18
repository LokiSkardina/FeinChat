const { MAX_TEXT, UserError } = require('./input.cjs');

const MAX_EVENT = 8 * 1024 * 1024;
const IDLE_TIMEOUT = 300_000;
const OPENAI_ORIGIN = 'https://api.openai.com';
const httpErrors = {
  400: 'The API rejected the request parameters.',
  401: 'The API rejected the key.',
  402: 'The API requires payment or a balance top-up.',
  403: 'The API denied access.',
  404: 'The API could not find the model or Chat Completions endpoint.',
  413: 'The API rejected the request size.',
  429: 'The API reported a rate limit.',
};

function providerMessage(error, apiKey) {
  const raw = typeof error === 'string' ? error : error?.message;
  if (typeof raw !== 'string') return '';
  return raw.replaceAll(apiKey, '[key hidden]')
    .replace(/\bBearer[ \t]+\S+/gi, 'Bearer [key hidden]')
    .replace(/\s+/g, ' ').trim().slice(0, 400);
}

function json(source) {
  try {
    const result = JSON.parse(source);
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch {
    // Report the protocol error without storing the raw response.
  }
  throw new UserError('The API returned invalid JSON.');
}

function readUsage(value, officialOpenRouter) {
  const usage = {};
  for (const [target, amount] of [
    ['inputTokens', value.prompt_tokens ?? value.input_tokens],
    ['outputTokens', value.completion_tokens ?? value.output_tokens],
    ['totalTokens', value.total_tokens],
  ]) {
    if (Number.isSafeInteger(amount) && amount >= 0 && amount <= 2_147_483_647) usage[target] = amount;
  }
  if (Number.isFinite(value.cost) && value.cost >= 0) {
    usage.cost = value.cost;
    if (typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency)) {
      usage.currency = value.currency;
    } else if (officialOpenRouter) {
      usage.currency = 'USD';
    }
  }
  return usage;
}

async function* responseChunks(body, onChunk) {
  if (!body) throw new UserError('The API returned an empty response.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        yield decoder.decode();
        return;
      }
      onChunk();
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function collect(chunks, limit) {
  let result = '';
  for await (const chunk of chunks) {
    result += chunk;
    if (result.length > limit) throw new UserError('The API returned a data packet that is too large.');
  }
  return result;
}

async function* events(chunks) {
  let pending = '';
  let data = '';
  for await (const chunk of chunks) {
    const segment = pending + chunk;
    const hasTrailingCR = segment.endsWith('\r');
    const complete = hasTrailingCR ? segment.slice(0, -1) : segment;
    const lines = complete.split(/\r\n|\n|\r/);
    pending = lines.pop() + (hasTrailingCR ? '\r' : '');
    for (const line of lines) {
      if (line.startsWith('data:')) {
        data += line.slice(5).replace(/^ /, '') + '\n';
        if (data.length > MAX_EVENT) throw new UserError('The API returned a data packet that is too large.');
      } else if (line === '' && data !== '') {
        yield data.trim();
        data = '';
      }
    }
    if (pending.length > MAX_EVENT) throw new UserError('The API returned a data packet that is too large.');
  }
  // Also accept a final event from compatible APIs that omit the empty separator.
  if (pending.startsWith('data:')) data += pending.slice(5).replace(/^ /, '');
  if (data.trim()) yield data.trim();
}

function supportsTemperature(origin, model) {
  if (origin === 'https://api.refuseless.com') return false;
  if (origin !== OPENAI_ORIGIN) return true;

  // OpenAI accepts sampling controls only when the model runs without reasoning.
  const reasoningModel = /^(?:o[134](?:-|$)|gpt-[56](?:[.-]|$))/i.test(model);
  const defaultsToNoReasoning = /^gpt-5\.(?:1|2|4(?:-(?:mini|nano))?)(?:-\d{4}-\d{2}-\d{2})?$/i.test(model);
  return !reasoningModel || defaultsToNoReasoning;
}

async function chatCompletion(config, messages, { signal, onText, onUsage }) {
  const url = new URL(config.baseUrl + '/chat/completions');
  const officialOpenRouter =
    ['openrouter.ai', 'eu.openrouter.ai', 'us.openrouter.ai'].includes(url.hostname) && url.port === '';
  const body = { model: config.model, messages, stream: true };
  if (config.temperature !== null && supportsTemperature(url.origin, config.model)) body.temperature = config.temperature;
  if (config.maxTokens !== null) {
    const limit = url.origin === OPENAI_ORIGIN || url.origin === 'https://api.groq.com' ? 'max_completion_tokens' : 'max_tokens';
    body[limit] = config.maxTokens;
  }

  const idle = new AbortController();
  let timer = setTimeout(() => idle.abort(), IDLE_TIMEOUT);
  const resetIdle = () => { timer.refresh(); };
  let chars = 0;
  let finishReason;
  let finalUsage;
  function accept(packet, streaming) {
    if (packet.error) {
      throw new UserError(providerMessage(packet.error, config.apiKey) || 'The API reported an error.');
    }
    const choice = Array.isArray(packet.choices) && packet.choices.find((item) => item && (item.index ?? 0) === 0);
    if (packet.usage && typeof packet.usage === 'object' &&
      (!streaming || finishReason || typeof choice?.finish_reason === 'string')) {
      finalUsage = readUsage(packet.usage, officialOpenRouter);
    }
    if (!choice) return;
    const part = streaming ? choice.delta : choice.message;
    const text = part?.content ?? part?.refusal;
    if (typeof text === 'string' && text) {
      chars += text.length;
      if (chars > MAX_TEXT) throw new UserError('The response exceeded the local limit of 1,000,000 characters.');
      onText(text);
    }
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    if (finishReason === 'error') throw new UserError('The API ended generation with an error.');
    if (finishReason === 'content_filter') throw new UserError('The API ended generation due to a content restriction.');
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.any([signal, idle.signal]),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        Authorization: 'Bearer ' + config.apiKey,
      },
      body: JSON.stringify(body),
    });
    resetIdle();
    const chunks = responseChunks(response.body, resetIdle);
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const hasJson = type === 'application/json' || type.endsWith('+json');
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new UserError('The API returned a redirect. Enter the final HTTPS Base URL in settings.');
    }
    if (!response.ok) {
      let detail = '';
      if (hasJson) {
        try {
          const payload = json(await collect(chunks, 64 * 1024));
          detail = providerMessage(payload.error ?? payload, config.apiKey);
        } catch {
          // The HTTP status is enough to describe an invalid error payload.
        }
      } else {
        await response.body?.cancel().catch(() => {});
      }
      const description = httpErrors[response.status] ||
        (response.status >= 500 ? 'The API encountered a server error.' : 'The API rejected the request.');
      throw new UserError(`HTTP ${response.status}. ${description}${detail ? ' ' + detail : ''}`);
    }
    if (hasJson) {
      accept(json(await collect(chunks, MAX_EVENT)), false);
    } else if (type === 'text/event-stream') {
      let done = false;
      for await (const data of events(chunks)) {
        if (!data) continue;
        if (data === '[DONE]') {
          done = true;
          break;
        }
        accept(json(data), true);
      }
      if (!done && !finishReason) throw new UserError('The connection closed before the API response was complete.');
    } else {
      await response.body?.cancel().catch(() => {});
      throw new UserError('The API returned an unexpected response format. Check the Base URL.');
    }
    if (!chars) throw new UserError('The API returned no response text.');
    if (finalUsage) onUsage(finalUsage);
    return finishReason;
  } catch (error) {
    if (signal.aborted || error instanceof UserError) throw error;
    if (idle.signal.aborted) throw new UserError('The API sent no data for 5 minutes.');
    throw new UserError(chars ? 'The connection to the API was interrupted during the response.' :
      'Could not connect to the API. Check your network and HTTPS Base URL.');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chatCompletion };
