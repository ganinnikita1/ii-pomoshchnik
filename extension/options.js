/** Настройки подключения DeepSeek, стиля письма, голосового ввода и приватности. */

import {
  STORAGE_KEYS,
  VOICE_LANGS,
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  normalizeSettings,
  originPattern,
  isDemoMode,
} from './lib/config.js';
import { hasOriginPermission, testConnection } from './lib/llm-client.js';
import { normalizeProfile, clearLearning, profileStats } from './lib/style-profile.js';

const $ = (id) => document.getElementById(id);

const el = {
  version: $('app-version'),
  apiKey: $('apiKey'),
  model: $('model'),
  modelHint: $('model-hint'),
  toggleKey: $('btn-toggle-key'),
  streaming: $('streaming'),
  testResult: $('test-result'),
  testIcon: $('test-icon'),
  testTitle: $('test-title'),
  testHint: $('test-hint'),
  btnTest: $('btn-test'),
  btnSave: $('btn-save'),
  btnReset: $('btn-reset'),
  styleCard: $('style-card'),
  stylePreview: $('style-preview'),
  emoji: $('emoji'),
  signoff: $('signoff'),
  signature: $('signature'),
  replyInstruction: $('replyInstruction'),
  styleBadge: $('style-badge'),
  learnedList: $('learned-list'),
  btnClearStyle: $('btn-clear-style'),
  btnExport: $('btn-export'),
  voiceEnabled: $('voice-enabled'),
  voiceLang: $('voice-lang'),
  voiceAutosend: $('voice-autosend'),
  voiceBadge: $('voice-badge'),
  voiceSupport: $('voice-support'),
  btnVoiceTest: $('btn-voice-test'),
  toast: $('toast'),
};

const state = {
  settings: normalizeSettings(null),
  profile: normalizeProfile(null),
};

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function toast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle('toast--error', isError);
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('is-visible'));
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.toast.classList.remove('is-visible');
    setTimeout(() => {
      el.toast.hidden = true;
    }, 200);
  }, 2800);
}

function readRadio(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : '';
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const theme = state.settings.theme;
  document.documentElement.dataset.theme = theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : theme;
}

darkQuery.addEventListener('change', () => {
  if (state.settings.theme === 'auto') applyTheme();
});

/* ------------------------------------------------------------------ */
/* form                                                                */
/* ------------------------------------------------------------------ */

function fillVoiceLanguages(selected) {
  el.voiceLang.textContent = '';
  for (const lang of VOICE_LANGS) {
    const option = document.createElement('option');
    option.value = lang.id;
    option.textContent = lang.label;
    el.voiceLang.appendChild(option);
  }
  el.voiceLang.value = selected;
}

let modelRequest = 0;

function fillModels(models, selected, unavailable = false) {
  el.model.replaceChildren();
  for (const id of models) el.model.add(new Option(id, id));
  if (!models.includes(selected)) {
    const option = new Option(unavailable ? selected + ' — недоступна' : selected, selected);
    option.disabled = unavailable;
    el.model.add(option, 0);
  }
  el.model.value = selected;
}

function resetModels(selected) {
  modelRequest += 1;
  el.btnTest.disabled = false;
  el.testResult.hidden = true;
  fillModels(PROVIDER_PRESETS.deepseek.models, selected);
  el.modelHint.textContent = 'Введите ключ и обновите список, чтобы увидеть доступные вам модели.';
}

function applyForm(settings, profile) {
  el.apiKey.value = settings.apiKey;
  resetModels(settings.model);
  el.streaming.checked = settings.streaming;

  fillVoiceLanguages(settings.voice.lang);
  el.voiceEnabled.checked = settings.voice.enabled;
  el.voiceAutosend.checked = settings.voice.autoSend;

  for (const [name, value] of [['tone', toneGroup(profile.prefs.formality)], ['length', profile.prefs.length]]) {
    el.styleCard.querySelector(`input[name="${name}"][value="${value}"]`).checked = true;
  }
  el.emoji.value = profile.prefs.emoji;
  el.signoff.value = profile.prefs.signoff;
  el.signature.value = profile.prefs.signature;
  const address = document.querySelector(`input[name="address"][value="${profile.prefs.address}"]`);
  if (address) address.checked = true;
  el.replyInstruction.value = settings.replyInstruction;

  renderStylePreview();
  renderLearned();
  renderVoiceAvailability();
}

function readForm() {
  const settings = normalizeSettings({
    ...state.settings,
    apiKey: el.apiKey.value.trim(),
    model: el.model.value,
    streaming: el.streaming.checked,
    replyInstruction: el.replyInstruction.value,
    voice: {
      enabled: el.voiceEnabled.checked,
      lang: el.voiceLang.value,
      autoSend: el.voiceAutosend.checked,
    },
  });
  const profile = normalizeProfile({
    ...state.profile,
    prefs: readStylePrefs(),
  });
  return { settings, profile };
}

/* ------------------------------------------------------------------ */
/* learned rules / voice                                               */
/* ------------------------------------------------------------------ */

function toneGroup(value) {
  return Math.max(2, Math.min(4, value));
}

function readStylePrefs() {
  const tone = Number(readRadio('tone'));
  const previous = state.profile.prefs.formality;
  return {
    // Existing profiles may use levels 1 or 5. Keep that nuance until the tone changes.
    formality: toneGroup(previous) === tone ? previous : tone,
    length: readRadio('length'), emoji: el.emoji.value, address: readRadio('address'),
    signoff: el.signoff.value.trim(), signature: el.signature.value.trim(),
  };
}

function renderStylePreview() {
  const prefs = readStylePrefs();
  const casual = prefs.address === 'ты';
  const tone = toneGroup(prefs.formality);
  const opening = tone === 2 ? 'Отлично, четверг подходит!' :
    tone === 4 ? 'Подтверждаю встречу в четверг в 15:00.' : 'В четверг в 15:00 мне удобно.';
  const request = casual ? 'Пришли, пожалуйста, ссылку.' : 'Пришлите, пожалуйста, ссылку.';
  const lines = [prefs.length === 'short' ? opening : opening + ' ' + request];
  if (prefs.length === 'detailed') lines.push(tone === 2 ? 'Соберу вопросы заранее, чтобы было время всё обсудить.' : 'До встречи подготовлю вопросы по проекту.');
  if (prefs.emoji === 'ok' && tone === 2) lines[0] += ' 🙂';
  const signature = [prefs.signoff, prefs.signature].filter(Boolean).join('\n');
  if (signature) lines.push(signature);
  el.stylePreview.textContent = lines.join('\n\n');
  const field = el.replyInstruction;
  for (const btn of el.styleCard.querySelectorAll('[data-rule]')) {
    const picked = field.value.split('\n').some(line => line.trim() === btn.dataset.rule);
    btn.setAttribute('aria-pressed', String(picked));
    btn.disabled = !picked && (field.value.trimEnd() + '\n' + btn.dataset.rule).trim().length > field.maxLength;
  }
}

async function saveStyleOnly() {
  const keys = STORAGE_KEYS;
  const prefs = readStylePrefs();
  const instruction = el.replyInstruction.value.trim();
  const stored = await chrome.storage.local.get([keys.settings, keys.profile]);
  const update = { [keys.profile]: { ...normalizeProfile(stored[keys.profile]), prefs } };
  const saved = normalizeSettings(stored[keys.settings]);
  if (saved.replyInstruction !== instruction) update[keys.settings] = { ...saved, replyInstruction: instruction };
  await chrome.storage.local.set(update);
  toast('Стиль сохранён');
}

function renderLearned() {
  el.learnedList.textContent = '';
  const stats = profileStats(state.profile);
  el.styleBadge.textContent = `${stats.samples} ${{ one: 'пример', few: 'примера', many: 'примеров', other: 'примера' }[new Intl.PluralRules('ru').select(stats.samples)]}`;
  el.styleBadge.className = stats.samples ? 'badge badge--ok' : 'badge';
  el.styleBadge.hidden = !stats.samples;
  el.btnClearStyle.hidden = !stats.samples && !stats.rules;
  const rules = state.profile.rules || [];
  if (!rules.length) {
    const empty = document.createElement('li');
    empty.className = 'learned__empty';
    empty.textContent =
      'Пока правил нет. Вставьте ответ в письмо, отредактируйте черновик и нажмите «Учиться на правке» в панели.';
    el.learnedList.appendChild(empty);
    return;
  }
  for (const rule of rules) {
    const item = document.createElement('li');
    item.textContent = rule.text;
    el.learnedList.appendChild(item);
  }
}

function renderVoiceAvailability() {
  const enabled = el.voiceEnabled.checked;
  if (!SpeechRecognitionCtor) {
    el.voiceBadge.textContent = 'нет';
    el.voiceBadge.className = 'badge badge--warning';
    el.voiceSupport.textContent = 'Браузер не поддерживает распознавание речи.';
    return;
  }
  el.voiceBadge.textContent = enabled ? 'доступен' : 'выключен';
  el.voiceBadge.className = enabled ? 'badge badge--ok' : 'badge';
  const langLabel = VOICE_LANGS.find((l) => l.id === el.voiceLang.value);
  el.voiceSupport.textContent = `Распознаёт браузер (${langLabel ? langLabel.label : el.voiceLang.value}).`;
}

function renderTestResult(kind, title, hint = '') {
  el.testResult.hidden = false;
  el.testResult.className = `test-result is-${kind}`;
  el.testIcon.setAttribute('href', kind === 'pending' ? '#i-plug' : kind === 'error' ? '#i-alert' : '#i-check');
  el.testTitle.textContent = title;
  el.testHint.textContent = hint;
}

/* ------------------------------------------------------------------ */
/* save / test / reset                                                 */
/* ------------------------------------------------------------------ */

async function persist(settings, profile) {
  state.settings = settings;
  state.profile = profile;
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: settings,
    [STORAGE_KEYS.profile]: profile,
  });
  applyTheme();
}

/** Запрос доступа к домену DeepSeek. Вызывать из обработчика клика (жест). */
function requestProviderPermission(settings) {
  const pattern = originPattern(settings.baseUrl);
  if (!pattern) return Promise.resolve(false);
  try {
    return chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function onSave() {
  const { settings, profile } = readForm();
  if (!isDemoMode(settings) && el.model.selectedOptions[0]?.disabled) {
    renderTestResult('error', 'Выберите доступную модель.', 'Настройки можно сохранить после выбора модели из списка.');
    el.model.focus();
    return;
  }
  // Вызов chrome.permissions.request должен идти сразу из жеста.
  const permissionPromise = isDemoMode(settings) ? Promise.resolve(true) : requestProviderPermission(settings);
  (async () => {
    const granted = await permissionPromise;
    await persist(settings, profile);
    toast(granted ? 'Сохранено' : 'Сохранено. Разрешите доступ к api.deepseek.com при запросе.', !granted);
  })().catch((error) => toast(`Не удалось сохранить: ${error && error.message ? error.message : error}`, true));
}

async function refreshModels(automatic = false) {
  const { settings } = readForm();
  if (!settings.apiKey) {
    renderTestResult('error', 'Вставьте API-ключ', 'Без ключа работает демо-режим.');
    el.apiKey.focus();
    return;
  }
  const request = ++modelRequest;
  el.btnTest.disabled = true;
  try {
    const granted = await (automatic ? hasOriginPermission(settings) : requestProviderPermission(settings));
    if (request !== modelRequest) return;
    if (!granted) {
      if (!automatic) renderTestResult('error', 'Нет доступа к api.deepseek.com', 'Разрешите доступ в окне браузера.');
      return;
    }
    renderTestResult('pending', 'Загружаем модели…');
    const result = await testConnection({ settings });
    if (request !== modelRequest) return;
    if (result.models) {
      let selected = el.model.value;
      const unavailable = !result.models.includes(selected);
      if (unavailable && result.models.length && !state.settings.apiKey) selected = result.models[0];
      fillModels(result.models, selected, !result.models.includes(selected));
      el.modelHint.textContent = result.models.length
        ? 'Выберите модель и нажмите «Сохранить настройки».'
        : 'Проверьте доступ к моделям в аккаунте DeepSeek.';
      if (result.ok && el.model.selectedOptions[0]?.disabled) {
        renderTestResult('error', 'Выбранная модель недоступна.', 'Выберите другую модель и сохраните настройки.');
        return;
      }
    }
    renderTestResult(result.ok ? 'ok' : 'error', result.message, result.hint || '');
  } finally {
    if (request === modelRequest) el.btnTest.disabled = false;
  }
}

function onReset() {
  const confirmed = window.confirm('Удалить ключ, настройки, историю чатов и данные обучения стилю?');
  if (!confirmed) return;
  (async () => {
    await navigator.locks.request(STORAGE_KEYS.chat, async () => {
      await chrome.storage.local.set({ [STORAGE_KEYS.chatReset]: crypto.randomUUID() });
      await chrome.storage.local.remove([STORAGE_KEYS.settings, STORAGE_KEYS.profile, STORAGE_KEYS.chat]);
    });
    try {
      const all = await chrome.permissions.getAll();
      const origins = (all.origins || []).filter((origin) => origin.startsWith('http'));
      if (origins.length) await chrome.permissions.remove({ origins });
    } catch {
      /* ignore */
    }
    state.settings = normalizeSettings(DEFAULT_SETTINGS);
    state.profile = normalizeProfile(null);
    applyForm(state.settings, state.profile);
    el.testResult.hidden = true;
    toast('Сброшено');
  })().catch((error) => toast(`Сброс не удался: ${error && error.message ? error.message : error}`, true));
}

async function onClearStyle() {
  if (!window.confirm('Удалить все примеры и выученные правила стиля?')) return;
  state.profile = clearLearning(state.profile);
  await chrome.storage.local.set({ [STORAGE_KEYS.profile]: state.profile });
  renderLearned();
  toast('Обучение стилю очищено');
}

function onExport() {
  const payload = {
    app: 'aibro',
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    note: 'API-ключ не экспортируется.',
    settings: { ...state.settings, apiKey: '' },
    profile: state.profile,
  };
  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ii-pomoshchnik-profile-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Профиль экспортирован');
  } catch (error) {
    toast(`Экспорт не удался: ${error && error.message ? error.message : error}`, true);
  }
}

function onVoiceTest() {
  renderVoiceAvailability();
  if (!SpeechRecognitionCtor) {
    toast('Распознавание речи недоступно в этом браузере', true);
    return;
  }
  toast('Голосовой ввод поддерживается. Микрофон запрашивается при первом использовании.');
}

/* ------------------------------------------------------------------ */
/* bindings / init                                                     */
/* ------------------------------------------------------------------ */

function bind() {
  el.styleCard.addEventListener('input', renderStylePreview);
  el.styleCard.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-rule]');
    if (!btn) return;
    const field = el.replyInstruction;
    const lines = field.value.trimEnd().split('\n');
    field.value = (btn.getAttribute('aria-pressed') === 'true'
      ? lines.filter(line => line.trim() !== btn.dataset.rule) : [...lines, btn.dataset.rule]).join('\n').trim();
    renderStylePreview();
  });
  $('btn-save-style').addEventListener('click', () => saveStyleOnly().catch(() => toast('Не удалось сохранить стиль. Попробуйте ещё раз.', true)));
  el.voiceEnabled.addEventListener('change', renderVoiceAvailability);
  el.voiceLang.addEventListener('change', renderVoiceAvailability);
  el.toggleKey.addEventListener('click', () => {
    const show = el.apiKey.type === 'password';
    el.apiKey.type = show ? 'text' : 'password';
    el.toggleKey.setAttribute('aria-label', show ? 'Скрыть ключ' : 'Показать ключ');
  });
  el.btnSave.addEventListener('click', onSave);
  el.apiKey.addEventListener('input', () => resetModels(el.model.value));
  el.model.addEventListener('change', () => {
    const unavailable = el.model.querySelector('option:disabled');
    if (unavailable && !el.model.selectedOptions[0]?.disabled) {
      unavailable.remove();
      renderTestResult('ok', 'Модель выбрана.', 'Нажмите «Сохранить настройки», чтобы применить выбор.');
    }
  });
  el.btnTest.addEventListener('click', () => refreshModels());
  el.btnReset.addEventListener('click', onReset);
  el.btnClearStyle.addEventListener('click', onClearStyle);
  el.btnExport.addEventListener('click', onExport);
  el.btnVoiceTest.addEventListener('click', onVoiceTest);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.settings]) {
      state.settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);
      applyTheme();
    }
    if (changes[STORAGE_KEYS.profile]) {
      state.profile = normalizeProfile(changes[STORAGE_KEYS.profile].newValue);
      renderLearned();
    }
  });
}

async function init() {
  el.version.textContent = `Версия ${chrome.runtime.getManifest().version}`;
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.profile]);
  state.settings = normalizeSettings(stored[STORAGE_KEYS.settings]);
  state.profile = normalizeProfile(stored[STORAGE_KEYS.profile]);
  // Сохраняем безопасные настройки старых установок.
  const rawSettings = stored[STORAGE_KEYS.settings];
  if (
    !rawSettings || rawSettings.schema !== 3 || rawSettings.provider !== 'deepseek' ||
    rawSettings.model !== state.settings.model || rawSettings.baseUrl !== state.settings.baseUrl ||
    rawSettings.apiKey !== state.settings.apiKey
  ) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: state.settings });
  }
  applyTheme();
  applyForm(state.settings, state.profile);
  bind();
  if (state.settings.apiKey) await refreshModels(true);
}

init().catch((error) => {
  console.error('[ИИ помощник options] init failed', error);
  toast(`Ошибка инициализации настроек: ${error && error.message ? error.message : error}`, true);
});
