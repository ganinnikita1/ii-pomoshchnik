// Run with Playwright installed: node tests/browser-regressions.cjs
// TEST_OUTPUT_DIR optionally keeps screenshots and the JSON result outside the temp fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-regressions-'));
const extension = path.join(root, 'extension');
const profile = path.join(root, 'profile');
const output = process.env.TEST_OUTPUT_DIR || path.join(root, 'results');
fs.mkdirSync(output, { recursive: true });
fs.cpSync(path.join(__dirname, '../extension'), extension, { recursive: true });
// Grant only the fixture API origin, avoiding a native permission dialog in unattended tests.
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['https://api.deepseek.com/*'];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const settings = {
  schema: 3, provider: 'deepseek', baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash', apiKey: 'fake-deepseek-browser-test-key', streaming: true, theme: 'dark',
};
const requests = [];
const modelIds = ['deepseek-v4-flash', 'future-family-preview', 'Future-Family/Model.2'];
const modelRequests = [];
let catalogMode = 'ok';
const errors = [];
const results = {};
let context, worker, base;
let responseMode = 'ok';
let releaseResponse;
const answer = 'Вариант 1: Подтверждаю встречу.\nВариант 2: Спасибо, договорились о встрече завтра.';
const longAnswer = Array.from({ length: 24 }, (_, n) => `Строка ${n + 1}: Проверочный ответ, который должен читаться при прокрутке.`).join('\n');
const sse = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  for (let n = 0; n < 100; n++) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: { width: 360, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  base = `chrome-extension://${worker.url().split('/')[2]}`;
  await context.route('https://api.deepseek.com/**', async (route) => {
    const req = route.request();
    if (new URL(req.url()).pathname === '/models' && req.method() === 'GET') {
      modelRequests.push(req.headers().authorization);
      if (catalogMode === 'offline') return route.abort('connectionfailed');
      if (catalogMode === 'unauthorized') return route.fulfill({ status: 401, json: { error: { message: 'Invalid API key' } } });
      return route.fulfill({ json: { object: 'list', data: modelIds.map(id => ({ id, object: 'model' })) } });
    }
    if (new URL(req.url()).pathname !== '/chat/completions' || req.method() !== 'POST') {
      errors.push(`Unexpected API request: ${req.method()} ${req.url()}`);
      return route.abort();
    }
    requests.push({ body: req.postDataJSON(), headers: req.headers() });
    const mode = responseMode;
    if (mode === 'hold') await new Promise((resolve) => { releaseResponse = resolve; });
    if (mode === 'error') {
      await route.fulfill({ status: 401, body: '{"error":{"message":"Test key rejected"}}' });
    } else {
      await route.fulfill({ contentType: 'text/event-stream', body: sse(mode === 'long' ? longAnswer : answer) }).catch(() => {});
    }
  });
}
async function storage() {
  return worker.evaluate(() => chrome.storage.local.get(null));
}
async function panelInWindow() {
  const url = `${base}/sidepanel.html?test=${crypto.randomUUID()}`;
  await worker.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 400, height: 900 }), url);
  await until(() => context.pages().some((page) => page.url() === url), 'panel page');
  const page = context.pages().find((page) => page.url() === url);
  await page.locator('#provider-state:visible, #mode-banner-text:visible').filter({ hasText: /DeepSeek|Демо/ }).waitFor();
  return page;
}
async function ask(page, question) {
  await page.locator('#input').fill(question);
  await page.locator('#btn-send').click();
}
async function idle(page) {
  await page.waitForFunction(() => document.querySelector('#chat').getAttribute('aria-busy') === 'false');
}
async function reset(options) {
  options.once('dialog', (dialog) => dialog.accept());
  await options.locator('#btn-reset').click();
  await until(async () => (await options.locator('#toast').textContent()) === 'Сброшено', 'settings reset');
}

(async () => {
  try {
    await launch();
    results.chromium = await worker.evaluate(() => navigator.userAgent);
    await until(async () => Boolean((await storage()).settings), 'extension installation');
    await worker.evaluate((settings) => chrome.storage.local.set({ settings }), {
      ...settings, baseUrl: 'https://api.openai.com/v1', apiKey: 'fake-foreign-provider-key',
    });
    const options = await context.newPage();
    await options.goto(`${base}/options.html`);
    await until(async () => (await storage()).settings?.apiKey === '', 'persisted foreign key removed');
    assert.equal((await storage()).settings.baseUrl, settings.baseUrl);
    assert.equal(requests.length, 0);
    results.migration = 'PASS: settings page persists the cleared foreign key without a network request';
    const model = options.getByRole('combobox', { name: /модел/i });
    const refresh = options.locator('#btn-test');
    await refresh.click();
    await options.locator('#test-result:visible').filter({ hasText: /ключ/i }).waitFor();
    const demo = await panelInWindow();
    await ask(demo, 'Что можно попробовать в демо?');
    await idle(demo);
    await demo.locator('.msg--assistant').first().waitFor();
    await demo.close();
    assert.deepEqual([modelRequests.length, requests.length], [0, 0], 'Demo must stay offline without a key');
    await options.locator('#apiKey').fill(settings.apiKey);
    await refresh.click();
    await until(async () => {
      const values = await model.locator('option').evaluateAll(items => items.filter(item => !item.disabled).map(item => item.value));
      return modelIds.every(id => values.includes(id));
    }, 'all API model IDs available');
    assert.deepEqual(modelRequests, [`Bearer ${settings.apiKey}`]);
    assert.equal(requests.length, 0, 'Listing models must not send a chat');
    const selectedModel = modelIds[2];
    await model.selectOption(selectedModel);
    await options.locator('#btn-save').click();
    await until(async () => (await storage()).settings.model === selectedModel, 'model saved');
    await options.reload();
    await until(async () => (await options.locator('#apiKey').inputValue()) === settings.apiKey, 'valid key preserved');
    await until(async () => modelRequests.length === 2 && await model.inputValue() === selectedModel && await refresh.isEnabled(), 'saved account catalog reloaded');
    for (const mode of ['unauthorized', 'offline']) {
      catalogMode = mode;
      const before = modelRequests.length;
      await refresh.click();
      await until(async () => modelRequests.length === before + 1 && await refresh.isEnabled() && await options.locator('#test-result.is-error').isVisible(), `catalog ${mode}`);
      if (mode === 'unauthorized') assert.match(await options.locator('#test-result').innerText(), /ключ|401/i);
      assert.equal(await model.inputValue(), selectedModel, 'Catalog failures must preserve the selected model');
      assert.equal((await storage()).settings.model, selectedModel);
    }
    catalogMode = 'ok';
    await refresh.click();
    await options.locator('#test-result.is-ok').waitFor();
    assert.equal(await model.inputValue(), selectedModel);
    const first = await panelInWindow();
    assert.ok((await first.locator('#provider-state').innerText()).includes(selectedModel), 'Reopened panel shows saved model');
    await first.emulateMedia({ reducedMotion: 'no-preference' });
    await first.locator('#btn-history').press('Enter');
    await first.locator('#drawer:visible').waitFor();
    assert.equal(await first.locator('.click-sparks').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    await first.locator('.click-sparks').waitFor({ state: 'detached' });
    await first.emulateMedia({ reducedMotion: 'reduce' });
    await first.locator('#btn-drawer-close').click();
    await first.locator('#drawer').waitFor({ state: 'hidden' });
    assert.equal(await first.locator('.click-sparks').count(), 0);
    results.motion = 'PASS: keyboard activation and reduced-motion click both work; particles do not intercept input';
    const second = await panelInWindow();
    const ids = await Promise.all([first, second].map((page) => page.evaluate(async () => (await chrome.windows.getCurrent()).id)));
    assert.notEqual(ids[0], ids[1], 'Panels must belong to separate browser windows');

    await ask(first, 'Предложи два варианта ответа');
    await idle(first);
    assert.equal(requests.at(-1).body.model, selectedModel, 'Chat request uses the exact selected model ID');
    results.models = 'PASS: demo stays offline; full account list, stored choice, 401 and offline recovery, panel and chat request verified';
    const firstChat = await first.locator('#chat').innerText();
    assert.ok(firstChat.includes(answer.split('\n')[1]), JSON.stringify({ firstChat, requests }));
    await ask(first, 'сократи второй вариант');
    await idle(first);
    const followup = requests.at(-1).body.messages;
    assert.ok(followup.some((m) => m.role === 'assistant' && m.content === answer));
    assert.equal(followup.filter((m) => m.role === 'user' && m.content.includes('сократи второй вариант')).length, 1);
    responseMode = 'error';
    await ask(first, 'Повтори после ошибки');
    await idle(first);
    await first.getByRole('button', { name: 'Повторить', exact: true }).waitFor();
    responseMode = 'ok';
    await first.getByRole('button', { name: 'Повторить', exact: true }).click();
    await idle(first);
    assert.equal(requests.at(-1).body.messages.filter((m) => m.role === 'user' && m.content.includes('Повтори после ошибки')).length, 1);
    assert.equal(await first.locator('.msg--user').filter({ hasText: 'Повтори после ошибки' }).count(), 1);
    results.history = 'PASS: previous answer retained, follow-up and retry question occur once in request and UI';

    await ask(second, 'Старый чат из второго окна');
    await idle(second);
    responseMode = 'hold';
    await ask(first, 'Удалить во время генерации');
    await until(() => Boolean(releaseResponse), 'pending generation');
    assert.equal(await first.locator('#chat').getAttribute('aria-busy'), 'true');
    await reset(options);
    for (const page of [first, second]) {
      await idle(page);
      assert.equal(await page.locator('.msg').count(), 0);
      await page.locator('#btn-history').click();
      assert.equal(await page.locator('.session-open').count(), 0);
      await page.locator('#btn-drawer-close').click();
    }
    releaseResponse();
    await wait(450); // Past the 350 ms persistence debounce, including the aborted request's finally.
    assert.equal((await storage()).chatSessions, undefined);
    await ask(second, 'Удалить до первого сохранения');
    assert.equal((await storage()).chatSessions, undefined);
    await reset(options);
    await idle(second);
    await wait(450);
    assert.equal((await storage()).chatSessions, undefined, 'Reset also clears unsaved chats');
    assert.equal(await second.locator('.msg').count(), 0);
    responseMode = 'ok';
    await ask(second, 'Новый вопрос после сброса');
    await idle(second);
    await until(async () => Boolean((await storage()).chatSessions?.length), 'fresh chat persisted');
    let saved = (await storage()).chatSessions;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].messages.filter((m) => m.role === 'user').length, 1);
    assert.equal(saved[0].messages[0].content, 'Новый вопрос после сброса');
    results.reset = 'PASS: in-flight and unsaved generations cancelled; both windows cleared; next message saves only a new chat';

    // Force a save already inside its critical section, then queue reset behind it.
    await second.evaluate(() => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = async (keys) => {
        if (keys === 'chatReset') {
          globalThis.savePaused = true;
          await new Promise((resolve) => { globalThis.releaseSave = resolve; });
          chrome.storage.local.get = get;
        }
        return get(keys);
      };
    });
    await second.locator('#btn-new').click();
    await ask(second, 'Запись одновременно со сбросом');
    await idle(second);
    await second.waitForFunction(() => globalThis.savePaused === true);
    options.once('dialog', (dialog) => dialog.accept());
    await options.locator('#btn-reset').click();
    await second.evaluate(() => globalThis.releaseSave());
    await until(async () => (await storage()).chatSessions === undefined, 'reset after queued save');
    await wait(450);
    assert.equal((await storage()).chatSessions, undefined);
    results.resetRace = 'PASS: a save already in progress cannot resurrect data after reset';

    await context.close();
    await launch();
    assert.equal((await storage()).chatSessions, undefined);
    const restarted = await panelInWindow();
    assert.equal(await restarted.locator('.msg').count(), 0);
    results.restart = 'PASS: deleted chats remain absent after browser restart';

    await worker.evaluate(() => {
      globalThis.panelOpenCalls = [];
      const open = chrome.sidePanel.open.bind(chrome.sidePanel);
      chrome.sidePanel.open = (options) => { globalThis.panelOpenCalls.push(options); return open(options); };
    });
    await context.route('https://mail.google.com/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Test mail</title><main><article>Тестовое письмо без персональных данных</article></main>',
    }));
    const mail = await context.newPage();
    await mail.goto('https://mail.google.com/mail/u/0/#inbox/test');
    const launcher = mail.locator('#pocherk-launcher').getByRole('button', { name: 'ИИ помощник: открыть панель', exact: true });
    await launcher.waitFor();
    await launcher.click();
    await until(async () => (await worker.evaluate(() => globalThis.panelOpenCalls.length)) === 1, 'one mouse open');
    await wait(100);
    assert.equal(await worker.evaluate(() => globalThis.panelOpenCalls.length), 1);
    await launcher.focus();
    await launcher.press('Enter');
    await until(async () => (await worker.evaluate(() => globalThis.panelOpenCalls.length)) === 2, 'one keyboard open');
    await wait(100);
    assert.equal(await worker.evaluate(() => globalThis.panelOpenCalls.length), 2);
    results.launcher = 'PASS: real click and Enter each call background chrome.sidePanel.open exactly once';

    const composeUrl = 'https://mail.yandex.ru/#compose/test';
    await context.route('https://mail.yandex.ru/**', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: '<style>[contenteditable],textarea{display:block;width:300px;height:90px}</style><main>Входящее</main><div contenteditable="true" aria-label="Кому">Адресат</div><div class="mail-Compose-Body" contenteditable="true">Начало черновика</div><div class="mail-Compose-Body" contenteditable="true">Другой черновик</div>',
    }));
    const compose = await context.newPage();
    await compose.goto(composeUrl);
    await compose.locator('#pocherk-launcher').waitFor();
    await compose.locator('#pocherk-launcher').getByRole('button').click();
    await until(async () => (await worker.evaluate(() => globalThis.panelOpenCalls.length)) === 3, 'Yandex tab id');
    const composeTab = await worker.evaluate(() => ({ id: globalThis.panelOpenCalls.at(-1).tabId }));
    const composeRequest = (message) => worker.evaluate(({ tabId, message }) => chrome.tabs.sendMessage(tabId, { target: 'content', ...message }), { tabId: composeTab.id, message });
    const message = { type: 'INSERT_TEXT', text: 'Ответ: <пример>\nДо встречи.' };
    assert.equal((await composeRequest(message)).ok, false, 'Do not guess between two drafts');
    await compose.locator('.mail-Compose-Body').first().focus();
    assert.equal((await composeRequest(message)).ok, true);
    assert.match(await compose.locator('.mail-Compose-Body').first().innerText(), /Начало черновика[\s\S]*Ответ: <пример>[\s\S]*До встречи\./);
    assert.equal(await compose.locator('.mail-Compose-Body').last().innerText(), 'Другой черновик');
    assert.equal(await compose.locator('[aria-label="Кому"]').innerText(), 'Адресат');
    assert.equal((await composeRequest({ type: 'GET_MAIL' })).ok, false);
    await compose.close();
    results.compose = 'PASS: explicit insertion into chosen Yandex fixture draft preserves existing text and other fields; legacy automatic letter reader is unavailable';

    const foreignPanel = await panelInWindow();
    await foreignPanel.locator('#manual-text').fill('Текст другого окна');
    const control = await context.newPage();
    await control.goto(`${base}/options.html`);
    const ownerId = await restarted.evaluate(async () => (await chrome.windows.getCurrent()).id);
    const selected = { id: 'selection-live-test', kind: 'selection', windowId: ownerId, ts: Date.now(), text: 'Тестовое письмо\nПроверьте срок поставки. <script>test only</script>' };
    const beforeSelection = requests.length;
    await control.evaluate(async (context) => {
      await chrome.storage.session.set({ [`pendingContext:${context.windowId}`]: context });
      await chrome.runtime.sendMessage({ type: 'CONTEXT_PUSH', context }).catch(() => {});
    }, selected);
    await until(async () => (await restarted.locator('#manual-text').inputValue()) === selected.text, 'live selection delivered');
    assert.equal(await foreignPanel.locator('#manual-text').inputValue(), 'Текст другого окна');
    assert.equal(await restarted.locator('#manual-text').evaluate((field) => document.activeElement === field), true);
    await until(async () => await worker.evaluate(async (id) => !Object.keys(await chrome.storage.session.get(`pendingContext:${id}`)).length, ownerId), 'consumed selection cleared');

    const targetWindow = await worker.evaluate(() => chrome.windows.create({ url: 'about:blank', type: 'normal' }));
    const pendingSelection = { ...selected, id: 'selection-cold-test', windowId: targetWindow.id, ts: Date.now() + 1, text: 'Письмо для ещё не открытой панели' };
    await control.evaluate((context) => chrome.storage.session.set({ [`pendingContext:${context.windowId}`]: context }), pendingSelection);
    const coldUrl = `${base}/sidepanel.html?test=cold-selection`;
    const coldTab = await worker.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url }), { windowId: targetWindow.id, url: coldUrl });
    assert.equal(coldTab.windowId, targetWindow.id);
    await until(() => context.pages().some((page) => page.url() === coldUrl), 'new panel tab');
    const coldPanel = context.pages().find((page) => page.url() === coldUrl);
    await until(async () => (await coldPanel.locator('#manual-text').inputValue()) === pendingSelection.text, 'selection loaded at panel startup');
    const sourceTab = await control.evaluate(() => chrome.tabs.getCurrent());
    const fallbackSelection = { ...selected, id: 'selection-fallback-test', windowId: sourceTab.windowId, ts: Date.now() + 2, text: 'Письмо для отдельного окна панели' };
    await control.evaluate((context) => chrome.storage.session.set({ [`pendingContext:${context.windowId}`]: context }), fallbackSelection);
    const fallbackUrl = `${base}/sidepanel.html?tabId=${sourceTab.id}&test=fallback-selection`;
    await worker.evaluate((url) => chrome.windows.create({ url, type: 'popup' }), fallbackUrl);
    await until(() => context.pages().some((page) => page.url() === fallbackUrl), 'fallback panel window');
    const fallbackPanel = context.pages().find((page) => page.url() === fallbackUrl);
    await until(async () => (await fallbackPanel.locator('#manual-text').inputValue()) === fallbackSelection.text, 'selection loaded in fallback window');
    await control.close();
    await fallbackPanel.reload();
    await fallbackPanel.locator('#provider-state:visible, #mode-banner-text:visible').filter({ hasText: /DeepSeek|Демо/ }).waitFor();
    assert.equal(requests.length, beforeSelection, 'Selecting text must not send an API request');
    await coldPanel.close();
    await fallbackPanel.close();
    await foreignPanel.close();
    results.selection = 'PASS: selected text fills live and newly opened panels, remains plain text, is consumed once, and stays in its source window; no API request';

    await worker.evaluate((settings) => chrome.storage.local.set({ settings }), settings);
    await restarted.waitForFunction(() => document.querySelector('#provider-state').textContent.includes('DeepSeek'));
    responseMode = 'long';
    await ask(restarted, 'Покажи длинный тестовый ответ');
    await idle(restarted);
    assert.equal(await restarted.evaluate(async () => {
      const fonts = await document.fonts.load('13px "Inter Variable"', 'Проверка Cyrillic');
      return fonts.length === 1 && fonts[0].status === 'loaded';
    }), true, 'Bundled Inter must actually load');
    results.layout = [];
    results.design = [];
    for (const theme of ['dark', 'light']) {
      await worker.evaluate((settings) => chrome.storage.local.set({ settings }), { ...settings, theme });
      await restarted.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
      const contrast = await restarted.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.cssText = 'color:var(--text-faint);background:var(--bg-elev-2)';
        document.body.appendChild(probe);
        const style = getComputedStyle(probe);
        const canvas = document.createElement('canvas').getContext('2d');
        const luminance = (color) => {
          canvas.fillStyle = color;
          canvas.fillRect(0, 0, 1, 1);
          const rgb = [...canvas.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const foreground = luminance(style.color), background = luminance(style.backgroundColor);
        probe.remove();
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      });
      assert.ok(contrast >= 4.5, `Small text contrast in ${theme}: ${contrast}`);
      results.design.push({ theme, smallTextContrast: Number(contrast.toFixed(2)), interLoaded: true });
      for (const height of [500, 410, 800]) {
        await restarted.setViewportSize({ width: 360, height });
        await restarted.locator('#input').fill('Доступная кнопка');
        await restarted.locator('#btn-send').scrollIntoViewIfNeeded();
        const button = await restarted.locator('#btn-send').boundingBox();
        assert.ok(button.y >= 0 && button.y + button.height <= height, `Send button visible at ${height}`);
        const dimensions = await restarted.locator('#chat').evaluate((chat) => ({ height: chat.clientHeight, content: chat.scrollHeight }));
        assert.ok(dimensions.height >= 120, `Readable chat at ${height}: ${JSON.stringify(dimensions)}`);
        assert.ok(dimensions.content > dimensions.height, 'Long answer has scrollable overflow');
        await restarted.locator('#chat').evaluate((chat) => { chat.scrollTop = chat.scrollHeight; });
        await restarted.locator('.msg--assistant').last().scrollIntoViewIfNeeded();
        await restarted.screenshot({ path: path.join(output, `panel-${theme}-360x${height}.png`) });
        await restarted.locator('#btn-send').scrollIntoViewIfNeeded();
        results.layout.push({ theme, width: 360, height, chatHeight: dimensions.height, sendAccessible: true });
      }
    }
    assert.ok(requests.every((r) => r.headers.authorization === `Bearer ${settings.apiKey}`));
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally {
    if (context) await context.close();
    // Only delete the uniquely created test fixture under the system temp directory.
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
