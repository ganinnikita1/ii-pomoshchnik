const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

(async () => {
  const extension = path.resolve(__dirname, '../extension');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, locale: 'ru-RU', colorScheme: 'light',
    viewport: { width: 1200, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-background-networking'],
  });
  try {
    const outbound = [], errors = [];
    context.on('request', r => { if (/^https?:/.test(r.url())) outbound.push(r.url()); });
    context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    await context.route(/^https?:/, route => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const origin = 'chrome-extension://' + new URL(worker.url()).host;
    const { normalizeSettings, DEFAULT_SETTINGS } = await import('../extension/lib/config.js');
    const { normalizeProfile } = await import('../extension/lib/style-profile.js');
    const seed = {
        settings: normalizeSettings({ ...DEFAULT_SETTINGS, apiKey: 'fixture-only', model: 'fixture-family/second-model', theme: 'auto' }),
        styleProfile: normalizeProfile({ samples: [{ id: 's1', ts: 11, kind: 'reply', draft: 'Секретный тестовый фрагмент.', final: 'Приватный исходный пример.' }],
          rules: [{ id: 'brief', weight: 1, text: 'Начинает письмо с сути.' }] }),
    };
    await worker.evaluate(v => chrome.storage.local.set(v), seed);
    const page = await context.newPage(); page.setDefaultTimeout(6000);
    await page.goto(`${origin}/options.html`);
    const card = page.locator('#style-card');
    const preview = card.locator('#style-preview');
    await page.waitForFunction(() => document.querySelector('#style-preview')?.textContent.trim());
    const baseline = await preview.innerText();
    const neutral = card.getByRole('radio', { name: 'Нейтральный' });
    await neutral.focus(); await neutral.press('ArrowRight');
    assert.equal(await card.getByRole('radio', { name: 'Деловой' }).isChecked(), true);
    assert.notEqual(await preview.innerText(), baseline, 'Keyboard choice changes live preview');
    const short = card.getByRole('radio', { name: 'Коротко' });
    await short.check();
    const shortText = await preview.innerText();
    await card.getByRole('radio', { name: 'Подробнее' }).check();
    assert.ok((await preview.innerText()).length > shortText.length, 'Detailed sample has more text');
    await card.locator('summary').filter({ hasText: 'Обращение и подпись' }).click();
    await card.getByRole('radio', { name: 'На «ты»' }).check();
    await card.locator('#signature').fill('Анна');
    assert.match(await preview.innerText(), /Анна/);
    const rulesToggle = card.locator('summary').filter({ hasText: 'Свои правила' });
    await rulesToggle.focus(); await rulesToggle.press('Enter');
    const custom = 'Цифры — в начале.\nДата — в конце.';
    const ruleField = card.locator('#replyInstruction');
    const firstTag = card.getByRole('button', { name: 'Без канцелярита' });
    const secondTag = card.getByRole('button', { name: 'Сначала вывод' });
    await ruleField.fill(custom);
    await firstTag.focus(); await firstTag.press('Space');
    await secondTag.click(); await firstTag.click();
    assert.equal(await ruleField.inputValue(), custom+'\nСначала вывод');
    await firstTag.click();
    const savedText = await ruleField.inputValue();
    await page.locator('#apiKey').fill('unsaved-fixture-only');
    const lateSample = { id: 's2', ts: 12, kind: 'reply', draft: 'Новый приватный набросок.', final: 'Новая тестовая редакция.' };
    await worker.evaluate(async sample => {
      const { styleProfile } = await chrome.storage.local.get('styleProfile');
      await chrome.storage.local.set({ styleProfile: { ...styleProfile, samples: [...styleProfile.samples, sample] } });
    }, lateSample);
    await card.getByRole('button', { name: 'Сохранить стиль' }).click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent === 'Стиль сохранён');
    const saved = await worker.evaluate(() => chrome.storage.local.get(['settings','styleProfile']));
    assert.deepEqual(saved.settings, { ...seed.settings, replyInstruction: savedText }, 'Only the reply instruction changes in account settings');
    assert.deepEqual(saved.styleProfile.samples, [...seed.styleProfile.samples,lateSample], 'Concurrent learned example preserved');
    assert.deepEqual(saved.styleProfile.rules, seed.styleProfile.rules);
    assert.deepEqual([saved.styleProfile.prefs.formality, saved.styleProfile.prefs.length, saved.styleProfile.prefs.address], [4,'detailed','ты']);
    const prompt = await page.evaluate(async () => {
      const { settings, styleProfile } = await chrome.storage.local.get(['settings','styleProfile']);
      const { buildStyleHints } = await import('./lib/style-profile.js');
      const { buildReplyTask } = await import('./lib/prompts.js');
      const task = buildReplyTask({ mail: { manual: true, messages: [{ body:'Учебное письмо' }] }, styleHints: buildStyleHints(styleProfile), instruction: settings.replyInstruction });
      return JSON.stringify([task.system, task.messages]);
    });
    for (const expected of ['4/5','два коротких абзаца','Анна','Начинает письмо с сути','Сначала вывод','Цифры']) assert.ok(prompt.includes(expected), expected);
    for (const privateText of [lateSample.draft, lateSample.final, seed.settings.apiKey, seed.styleProfile.samples[0].draft]) assert.ok(!prompt.includes(privateText));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#style-preview').textContent.includes('Анна'));
    assert.equal(await card.getByRole('radio', { name: 'Деловой' }).isChecked(), true);
    assert.equal(await card.getByRole('radio', { name: 'Подробнее' }).isChecked(), true);
    await rulesToggle.click();
    assert.equal(await ruleField.inputValue(), savedText);
    assert.equal(await firstTag.getAttribute('aria-pressed'), 'true');
    assert.equal(await secondTag.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#apiKey').inputValue(), seed.settings.apiKey);
    await card.locator('summary').filter({ hasText: 'Обращение и подпись' }).click();
    if (process.env.TEST_OUTPUT_DIR) await fs.mkdir(process.env.TEST_OUTPUT_DIR, { recursive: true });
    for (const [width, theme] of [[1200,'light'], [360,'dark']]) {
      await page.setViewportSize({width,height:950}); await page.emulateMedia({colorScheme:theme});
      await page.waitForFunction(t => document.documentElement.dataset.theme === t, theme);
      assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal scrolling');
      if (process.env.TEST_OUTPUT_DIR) {
        const height = Math.ceil((await card.boundingBox()).height) + 160;
        await page.setViewportSize({width,height});
        await card.evaluate(el => scrollTo(0, el.getBoundingClientRect().top + scrollY - 100));
        await card.screenshot({path:path.join(process.env.TEST_OUTPUT_DIR,`style-${width}-${theme}.png`),animations:'disabled'});
      }
    }
    assert.deepEqual(outbound, [], 'No network in this style-only workflow without provider permission');
    assert.deepEqual(errors, []);
    console.log('PASS: keyboard, tone/length preview, multiline rules and tags, persisted settings, latest learning data, prompt privacy, light and mobile dark layouts; no network or browser errors.');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
