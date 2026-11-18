import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeSettings } from '../extension/lib/config.js';
import { buildRequest, streamTask, testConnection } from '../extension/lib/llm-client.js';

const task = { system: 'Test only', messages: [{ role: 'user', content: 'Test message' }] };
const requests = [];
globalThis.chrome = { permissions: { contains: async () => true } };
globalThis.fetch = async (url, options) => {
  requests.push({ url, ...options });
  return new Response(JSON.stringify({ choices: [{ message: { content: 'Test response' } }] }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

for (const baseUrl of [
  undefined, '', 'not a URL', 'api.deepseek.com',
  'https://api.openai.com/v1', 'https://api.anthropic.com/v1', 'http://localhost:11434',
  'http://api.deepseek.com', 'https://api.deepseek.com.evil.test',
  'https://api.deepseek.com@evil.test', 'https://api.deepseek.com:8443',
]) {
  const raw = { schema: 2, provider: 'deepseek', baseUrl, apiKey: 'fake-foreign-provider-key' };
  const migrated = normalizeSettings(raw);
  assert.equal(migrated.apiKey, '', String(baseUrl));
  assert.deepEqual(normalizeSettings(migrated), migrated);
  assert.throws(() => buildRequest(raw, task), { code: 'NO_KEY' });
  assert.throws(() => buildRequest(migrated, task), { code: 'NO_KEY' });
  await assert.rejects(async () => {
    for await (const event of streamTask({ settings: raw, task })) assert.fail(JSON.stringify(event));
  }, { code: 'DEMO' });
  assert.equal((await testConnection({ settings: raw })).code, 'NO_KEY');
}
assert.equal(requests.length, 0, 'Foreign keys must never reach fetch');

for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/', 'HTTPS://API.DEEPSEEK.COM:443/']) {
  const raw = { ...DEFAULT_SETTINGS, baseUrl, apiKey: ' fake-deepseek-key ', streaming: false };
  const migrated = normalizeSettings(raw);
  assert.equal(migrated.apiKey, 'fake-deepseek-key');
  assert.deepEqual(normalizeSettings(migrated), migrated);
  assert.equal(buildRequest(raw, task).headers.Authorization, 'Bearer fake-deepseek-key');
  for await (const event of streamTask({ settings: migrated, task })) {
    assert.deepEqual(event, { type: 'done', text: 'Test response' });
  }
}
assert.equal(requests.length, 3);
assert.ok(requests.every((request) => request.url === 'https://api.deepseek.com/chat/completions'));
assert.ok(requests.every((request) => request.headers.Authorization === 'Bearer fake-deepseek-key'));
assert.ok(!JSON.stringify(requests).includes('fake-foreign-provider-key'));
const newModel = 'Future-Family/Model.2';
const saved = normalizeSettings({ ...DEFAULT_SETTINGS, model: newModel, apiKey: 'fake-deepseek-key' });
assert.deepEqual(normalizeSettings(saved), saved);
const { body } = buildRequest(saved, task);
assert.equal(body.model, newModel);
assert.ok(!('thinking' in body) && !('reasoning_effort' in body) && !('temperature' in body));
for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
  assert.equal(buildRequest({ ...saved, model }, task).body.reasoning_effort, 'high');
}
assert.equal(normalizeSettings({ ...saved, model: ' ' }).model, DEFAULT_SETTINGS.model);
assert.equal(normalizeSettings({ ...saved, baseUrl: 'https://elsewhere.test' }).model, DEFAULT_SETTINGS.model);

const catalog = { data: [
  { id: 'deepseek-v4-pro' }, { id: newModel }, { id: 'Model β' },
  { id: newModel }, { name: 'display name only' }, null, { id: '' },
] };
const responses = [
  [Response.json(catalog), null],
  [Response.json({ data: [] }), 'NO_MODELS'],
  [Response.json({ models: [] }), 'BAD_RESPONSE'],
  [new Response('not JSON'), 'BAD_RESPONSE'],
  [new Response('echo fake-deepseek-key', { status: 401 }), 'AUTH'],
  [new Response('', { status: 503 }), 'SERVER'],
  [new Error('network fake-deepseek-key'), 'NETWORK'],
];
for (const [response, code] of responses) {
  let fetches = 0;
  globalThis.fetch = async (url, options) => {
    fetches++;
    assert.equal(url, 'https://api.deepseek.com/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer fake-deepseek-key');
    if (response instanceof Error) throw response;
    return response;
  };
  const result = await testConnection({ settings: { ...saved, model: 'retired' } });
  assert.equal(fetches, 1);
  assert.equal(result.ok, !code);
  if (code) assert.equal(result.code, code);
  else assert.deepEqual(result.models, ['deepseek-v4-pro', newModel, 'Model β']);
  assert.ok(!JSON.stringify(result).includes('fake-deepseek-key'));
}
console.log('PASS: origin-safe migration, selected model round-trip, official catalog, errors without generation or key disclosure.');
