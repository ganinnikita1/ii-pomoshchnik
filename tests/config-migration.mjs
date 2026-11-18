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
console.log('PASS: foreign/missing/HTTP/lookalike origins clear keys without fetch; valid DeepSeek settings and requests preserve fake keys.');
