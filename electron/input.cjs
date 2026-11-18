const MAX_TEXT = 1_000_000;
const MAX_CONTEXT = 8_000_000;

class UserError extends Error {}

function requireInput(condition, message = 'Invalid operation data.') {
  if (!condition) throw new UserError(message);
}

function id(value) {
  requireInput(Number.isSafeInteger(value) && value > 0);
  return value;
}

function text(value, limit, label, { trim = true, optional = false } = {}) {
  requireInput(typeof value === 'string' && value.length <= limit && !value.includes('\0'),
    `The ${label} field must contain no more than ${limit} characters.`);
  const compact = value.trim();
  requireInput(optional || compact.length > 0, `Enter a value for ${label}.`);
  return trim ? compact : value;
}

function baseUrl(value) {
  const raw = text(value, 2048, 'HTTPS Base URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError('Enter a valid HTTPS Base URL.');
  }
  requireInput(/^https:\/\//i.test(raw) && url.protocol === 'https:' && url.hostname && !url.username && !url.password &&
    !raw.includes('?') && !raw.includes('#') && !raw.includes('\\'),
  'The Base URL must start with https:// and contain no credentials, query parameters, or fragment.');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return url.origin + path;
}

function generationParameters(value) {
  requireInput(value && typeof value === 'object' && !Array.isArray(value));
  requireInput(value.temperature === null ||
    (Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2),
  'Temperature must be a number from 0 to 2.');
  requireInput(value.maxTokens === null ||
    (Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0 && value.maxTokens <= 2_147_483_647),
  'The token limit must be a positive integer up to 2,147,483,647.');
  return { temperature: value.temperature, maxTokens: value.maxTokens };
}

function providerInput(value) {
  requireInput(value && typeof value === 'object');
  const apiKey = text(value.apiKey, 4096, 'API key', { optional: true });
  requireInput(!apiKey || /^[\x21-\x7e]+$/.test(apiKey), 'The API key contains spaces or invalid characters.');
  requireInput(typeof value.clearKey === 'boolean' && !(apiKey && value.clearKey));
  const parameters = generationParameters(value);
  return {
    id: value.id === null ? null : id(value.id),
    name: text(value.name, 100, 'Connection name'),
    baseUrl: baseUrl(value.baseUrl),
    apiKey,
    clearKey: value.clearKey,
    model: text(value.model, 256, 'Model ID', { optional: true }),
    ...parameters,
  };
}

module.exports = { MAX_TEXT, MAX_CONTEXT, UserError, requireInput, id, text, providerInput, generationParameters };
