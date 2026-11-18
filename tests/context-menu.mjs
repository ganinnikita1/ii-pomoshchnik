import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LIMITS, STORAGE_KEYS } from '../extension/lib/config.js';

// Run the real service worker with fake Chrome APIs; all text and storage are test-only.
const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); } });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const menuItems = [];
const calls = [];
const messages = [];
const session = {};
let networkCalls = 0;
let scrapeCalls = 0;
let insideClick = false;
const forbidden = () => { scrapeCalls++; throw new Error('DOM scraping is forbidden in this scenario'); };
const chrome = {
  contextMenus: {
    onClicked: event(),
    removeAll(callback) { menuItems.length = 0; callback(); },
    create(item, callback) { menuItems.push(structuredClone(item)); callback(); },
  },
  sidePanel: {
    setPanelBehavior: async () => {},
    open(options) {
      assert.ok(insideClick, 'sidePanel.open must run synchronously inside the menu user gesture');
      calls.push({ type: 'open', options });
      return Promise.resolve();
    },
  },
  storage: {
    session: {
      async set(values) { calls.push({ type: 'set' }); Object.assign(session, structuredClone(values)); },
      async get(key) { return structuredClone({ [key]: session[key] }); },
      async remove(key) { calls.push({ type: 'remove' }); delete session[key]; },
    },
    local: { get: async () => ({}), set: async () => {}, async setAccessLevel({ accessLevel }) { assert.equal(accessLevel, 'TRUSTED_CONTEXTS'); } },
  },
  runtime: {
    onMessage: event(), onInstalled: event(), onStartup: event(),
    sendMessage: async (message) => { calls.push({ type: 'push' }); messages.push(structuredClone(message)); },
    openOptionsPage: async () => {},
    getURL: (path) => `chrome-extension://test/${path}`,
  },
  tabs: {
    query: async () => [], get: async () => null, sendMessage: forbidden,
    onActivated: event(), onUpdated: event(), onRemoved: event(),
  },
  action: { onClicked: event() },
  commands: { onCommand: event() },
  scripting: { executeScript: forbidden },
  windows: { create: async () => assert.fail('Unexpected panel fallback') },
};

const globals = ['chrome', 'fetch', 'window', 'document'];
const originals = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.defineProperties(globalThis, {
  chrome: { configurable: true, value: chrome },
  fetch: { configurable: true, value: () => { networkCalls++; throw new Error('Network is forbidden in this test'); } },
  window: { configurable: true, get: forbidden },
  document: { configurable: true, get: forbidden },
});

try {
  const file = new URL('../extension/background.js', import.meta.url);
  const source = (await readFile(file, 'utf8')).replace(
    /from (['"])\.\/lib\/config\.js\1/,
    `from ${JSON.stringify(new URL('../extension/lib/config.js', import.meta.url).href)}`,
  );
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  assert.equal(chrome.contextMenus.onClicked.listeners.length, 1);
  assert.equal(chrome.runtime.onMessage.listeners.length, 1);
  chrome.runtime.onStartup.listeners[0]();
  await settle();
  assert.deepEqual(menuItems, [{ id: 'open-ai-bro', title: 'Открыть «ИИ помощник»', contexts: ['page', 'selection'] }]);

  const onClick = chrome.contextMenus.onClicked.listeners[0];
  const tab = { id: 17, windowId: 42, url: 'https://example.test/mail', title: 'Fake mail' };
  function click(info, target = tab) {
    const count = calls.filter((call) => call.type === 'open').length;
    insideClick = true;
    try { onClick(info, target); } finally { insideClick = false; }
    return calls.filter((call) => call.type === 'open').length - count;
  }
  async function pending(windowId, extra = {}) {
    return new Promise((resolve) => {
      const result = chrome.runtime.onMessage.listeners[0](
        { type: 'GET_PENDING_CONTEXT', windowId, ...extra }, {}, resolve,
      );
      assert.equal(result, true, 'Pending response must keep the message channel open');
    });
  }

  assert.equal(click({ menuItemId: 'unknown', selectionText: 'Fake selection' }), 0);
  assert.equal(click({ menuItemId: 'open-ai-bro', selectionText: 'Fake selection' }, null), 0);
  assert.equal(click({ menuItemId: 'open-ai-bro' }, { windowId: 42 }), 0);
  await settle();
  assert.deepEqual(calls, [], 'Unknown menu IDs and missing tabs must do nothing');

  for (const selectionText of [undefined, '', ' \n\t ']) {
    assert.equal(click({ menuItemId: 'open-ai-bro', selectionText }), 1);
    await settle();
  }
  assert.equal(messages.length, 0);
  assert.equal(session[`${STORAGE_KEYS.pending}:42`], undefined);
  assert.ok(calls.every((call) => call.type === 'open'), 'No selection must only open the panel');
  calls.length = 0;

  const text = 'Тестовое письмо для разбора';
  const started = Date.now();
  assert.equal(click({ menuItemId: 'open-ai-bro', selectionText: text }), 1);
  assert.equal(calls[0].type, 'open', 'Open must precede pending storage and messages');
  assert.deepEqual(calls[0].options, { tabId: tab.id });
  await settle();
  assert.deepEqual(calls.map((call) => call.type), ['open', 'set', 'push']);
  assert.equal(messages.length, 1);
  const context = messages[0].context;
  assert.equal(messages[0].type, 'CONTEXT_PUSH');
  assert.equal(context.kind, 'selection');
  assert.equal(context.text, text);
  assert.equal(context.windowId, tab.windowId);
  assert.ok(typeof context.id === 'string' && context.id.length > 0);
  assert.ok(context.ts >= started && context.ts <= Date.now());
  assert.deepEqual(session[`${STORAGE_KEYS.pending}:42`], context);

  assert.deepEqual(await pending(99), { ok: true, context: null });
  assert.deepEqual(session[`${STORAGE_KEYS.pending}:42`], context, 'Another window must not clear the selection');
  assert.equal(calls.filter((call) => call.type === 'remove').length, 0);
  assert.deepEqual(await pending(42, { clear: false }), { ok: true, context });
  assert.deepEqual(session[`${STORAGE_KEYS.pending}:42`], context, 'clear:false must retain the selection');
  assert.deepEqual(await pending(42), { ok: true, context });
  assert.equal(session[`${STORAGE_KEYS.pending}:42`], undefined);
  assert.deepEqual(await pending(42, { clear: false }), { ok: true, context: null });

  assert.equal(click({ menuItemId: 'open-ai-bro', selectionText: 'я'.repeat(LIMITS.mailChars + 50) }), 1);
  await settle();
  const longContext = messages.at(-1).context;
  assert.equal(longContext.text, 'я'.repeat(12000));
  assert.equal(longContext.text.length, LIMITS.mailChars);
  assert.notEqual(longContext.id, context.id, 'Each selection needs its own identity');
  click({ menuItemId: 'open-ai-bro', selectionText: 'Второе окно' }, { ...tab, id: 18, windowId: 99 });
  await settle();
  assert.deepEqual((await pending(42)).context, longContext);
  assert.equal((await pending(99)).context.text, 'Второе окно');
  assert.equal(networkCalls, 0, 'Context menu must never call the network');
  assert.equal(scrapeCalls, 0, 'Context menu must never scrape DOM or inject a content script');
  console.log('PASS: context-menu selection, immediate panel opening, empty/invalid clicks, 12000-char limit, and window isolation.');
} finally {
  for (const key of globals) {
    const descriptor = originals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
