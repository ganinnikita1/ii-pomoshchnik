import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../extension/lib/config.js';
import { streamTask } from '../extension/lib/llm-client.js';

globalThis.chrome = { permissions: { contains: async () => true } };
const settings = { ...DEFAULT_SETTINGS, apiKey: 'fixture' };
const task = { system: '', messages: [{ role: 'user', content: 'Тест' }] };
const chunk = 'data: {"choices":[{"delta":{"content":"Ответ"}}]}\n\n';
async function run(responses) {
  let index = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.ok(index < responses.length, 'Unexpected retry');
    return responses[index++]();
  };
  const events = [];
  for await (const event of streamTask({ settings, task })) events.push(event);
  return events;
}
assert.equal((await run([() => new Response(chunk + 'data: [DONE]\n\n')])).at(-1).text, 'Ответ');
await assert.rejects(run([() => new Response(chunk)]), { code: 'BAD_RESPONSE' });
await assert.rejects(run([() => new Response('unsupported model', { status: 400 })]), { code: 'BAD_REQUEST' });
assert.ok((await run([() => new Response('unsupported field thinking', { status: 400 }), () => new Response(chunk + 'data: [DONE]\n\n')])).some((event) => event.type === 'notice'));
console.log('PASS: complete and interrupted streams, explicit permission origin, and reasoning fallback.');
