/**
 * background.js — service worker (MV3) для Chrome и Edge.
 *
 * Задачи:
 *  - открывать side panel (иконка, горячая клавиша Ctrl+Shift+Y, контекстное меню);
 *  - контекстное меню «ИИ помощник» для выделенного текста;
 *  - по требованию инжектировать content.js в активную вкладку (activeTab + scripting);
 *  - маршрутизировать сообщения между side panel и content script;
 *  - хранить «отложенный контекст» (выделение/письмо), пока панель загружается.
 *
 * Здесь НЕТ сетевых вызовов: за LLM отвечает side panel через lib/llm-client.js.
 */

import { STORAGE_KEYS, DEFAULT_SETTINGS, LIMITS, isWebmailHost } from './lib/config.js';

const MENU_OPEN = 'open-ai-bro';
const CONTENT_TARGET = 'content';

const pendingByWindow = new Map();
let cachedActiveTab = null;

function rememberActiveTab(tab) {
  if (!tab || !Number.isInteger(tab.id)) return;
  // В кэш — только настоящие http(s)-вкладки: chrome-extension:// и chrome://
  // не должны становиться «активной вкладкой» панели.
  if (!/^https?:/i.test(tab.url || '')) return;
  cachedActiveTab = {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || '',
    title: tab.title || '',
  };
}

function toTabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || '',
    title: tab.title || '',
    isMail: isWebmailUrl(tab.url || ''),
    restricted: /^(chrome|edge|about|devtools|chrome-extension|view-source):/i.test(tab.url || ''),
  };
}

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */

function isWebmailUrl(url) {
  try {
    const parsed = new URL(url);
    return isWebmailHost(parsed.hostname);
  } catch {
    return false;
  }
}

function safeRuntimeSend(message) {
  try {
    const promise = chrome.runtime.sendMessage(message);
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  } catch {
    /* нет слушателя — панель закрыта */
  }
}

function pendingKey(windowId) {
  return `${STORAGE_KEYS.pending}:${windowId}`;
}

async function setPending(context) {
  if (!Number.isInteger(context.windowId)) return;
  pendingByWindow.set(context.windowId, context);
  try { await chrome.storage.session.set({ [pendingKey(context.windowId)]: context }); } catch {}
}

async function readPending(windowId) {
  if (!Number.isInteger(windowId)) return null;
  if (pendingByWindow.has(windowId)) return pendingByWindow.get(windowId);
  try {
    const key = pendingKey(windowId);
    const data = await chrome.storage.session.get(key);
    return pendingByWindow.has(windowId) ? pendingByWindow.get(windowId) : data[key] || null;
  } catch { return null; }
}

async function clearPending(id, windowId) {
  if (!Number.isInteger(windowId)) return;
  const current = await readPending(windowId);
  if (!current || (id && current.id !== id) || (pendingByWindow.has(windowId) && pendingByWindow.get(windowId) !== current)) return;
  pendingByWindow.set(windowId, null);
  try {
    await chrome.storage.session.remove(pendingKey(windowId));
    if (pendingByWindow.get(windowId) === null) pendingByWindow.delete(windowId);
  } catch {}
}

/* ------------------------------------------------------------------ */
/* side panel                                                          */
/* ------------------------------------------------------------------ */

async function setupSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    return true;
  } catch (error) {
    console.warn('[ИИ помощник] setPanelBehavior недоступен:', error && error.message);
    return false;
  }
}

async function openPanelWindow(tab) {
  // Chrome 114–115: sidePanel.open() ещё нет — открываем панель отдельным окном.
  // Передаём tabId, иначе popup увидит собственную extension-вкладку как active.
  try {
    const target = tab && Number.isInteger(tab.id) ? tab : cachedActiveTab;
    const base = chrome.runtime.getURL('sidepanel.html');
    const url = target && Number.isInteger(target.id) ? `${base}?tabId=${target.id}` : base;
    await chrome.windows.create({ url, type: 'popup', width: 430, height: 800 });
    return true;
  } catch (error) {
    console.warn('[ИИ помощник] fallback window:', error && error.message);
    return false;
  }
}

/**
 * Открывает панель. ВАЖНО: chrome.sidePanel.open() вызывается синхронно,
 * до первого await — иначе браузер теряет user gesture.
 */
function openPanelForTab(tab) {
  const target = tab && Number.isInteger(tab.id) ? tab : cachedActiveTab;
  if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
    const options = [];
    if (target && Number.isInteger(target.id)) options.push({ tabId: target.id });
    if (target && Number.isInteger(target.windowId)) options.push({ windowId: target.windowId });
    for (const option of options) {
      try {
        const promise = chrome.sidePanel.open(option);
        if (promise && typeof promise.catch === 'function') {
          promise.catch((error) => {
            console.warn('[ИИ помощник] sidePanel.open не удался, fallback:', error && error.message);
            openPanelWindow(target);
          });
        }
        return true;
      } catch (error) {
        console.warn('[ИИ помощник] sidePanel.open исключение:', error && error.message);
      }
    }
  }
  openPanelWindow(target);
  return false;
}

/* ------------------------------------------------------------------ */
/* context menu                                                        */
/* ------------------------------------------------------------------ */

let menuSync = Promise.resolve();

function createContextMenus() {
  // Идемпотентно: вызовы с onInstalled/onStartup/старта service worker
  // сериализуются, поэтому дубликаты id и Unchecked runtime.lastError не появляются.
  menuSync = menuSync
    .then(
      () =>
        new Promise((resolve) => {
          try {
            chrome.contextMenus.removeAll(() => {
              void chrome.runtime.lastError;
              const items = [{ id: MENU_OPEN, title: 'Открыть «ИИ помощник»', contexts: ['page', 'selection'] }];
              for (const item of items) {
                try {
                  chrome.contextMenus.create(item, () => {
                    void chrome.runtime.lastError;
                  });
                } catch {
                  /* ignore */
                }
              }
              resolve();
            });
          } catch {
            resolve();
          }
        }),
    )
    .catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info || info.menuItemId !== MENU_OPEN || !tab || !Number.isInteger(tab.id)) return;
  openPanelForTab(tab);
  const text = String(info.selectionText || '').trim();
  if (!text) return;
  const context = {
    id: crypto.randomUUID(),
    kind: 'selection',
    text: text.slice(0, LIMITS.mailChars),
    truncated: text.length > LIMITS.mailChars,
    windowId: tab.windowId,
    ts: Date.now(),
  };
  setPending(context).then(() => safeRuntimeSend({ type: 'CONTEXT_PUSH', context }));
});

/* ------------------------------------------------------------------ */
/* action / commands                                                   */
/* ------------------------------------------------------------------ */

chrome.action.onClicked.addListener((tab) => {
  // Сработает только если setPanelBehavior не включился (старый браузер/Edge).
  openPanelForTab(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open-panel') return;
  if (tab && Number.isInteger(tab.id)) {
    openPanelForTab(tab);
    return;
  }
  chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then((tabs) => {
      const tab = tabs && tabs[0];
      if (tab) openPanelForTab(tab);
      else chrome.runtime.openOptionsPage();
    })
    .catch(() => {});
});

/* ------------------------------------------------------------------ */
/* content script injection (activeTab + scripting)                    */
/* ------------------------------------------------------------------ */

function classifyInjectionError(error) {
  const message = String((error && error.message) || error || '');
  if (/chrome:\/\//.test(message) || /chrome-extension:\/\//.test(message)) return 'RESTRICTED_URL';
  if (/extensions gallery|cannot be scripted/i.test(message)) return 'WEBSTORE';
  if (/Cannot access contents|Missing host permission|The extensions gallery/i.test(message)) return 'NO_HOST_ACCESS';
  if (/No tab with id|Invalid tab ID/i.test(message)) return 'NO_TAB';
  return 'INJECT_FAILED';
}

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { target: CONTENT_TARGET, type: 'PING' });
    if (ping && ping.ok) return { ok: true, injected: false, isMail: !!ping.isMail, site: ping.site || null };
  } catch {
    /* ещё не внедрён */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (error) {
    return { ok: false, injected: false, reason: classifyInjectionError(error), message: String((error && error.message) || error) };
  }
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { target: CONTENT_TARGET, type: 'PING' });
    if (ping && ping.ok) return { ok: true, injected: true, isMail: !!ping.isMail, site: ping.site || null };
    return { ok: false, injected: true, reason: 'NO_RESPONSE' };
  } catch {
    return { ok: false, injected: true, reason: 'NO_RESPONSE' };
  }
}

/* ------------------------------------------------------------------ */
/* messages                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;
  const type = message.type;

  // --- от content script: пользователь нажал плавающую кнопку на почте
  if (type === 'AI_COPILOT_FROM_PAGE') {
    if (!sender?.tab || !isWebmailUrl(sender.url || sender.tab.url)) return undefined;
    openPanelForTab(sender.tab);
    sendResponse({ ok: true });
    return undefined;
  }

  if (sender?.tab && !sender.url?.startsWith(chrome.runtime.getURL(''))) return undefined;

  if (type === 'ENSURE_CONTENT') {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, reason: 'NO_TAB' });
      return undefined;
    }
    ensureContentScript(tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: 'INJECT_FAILED', message: String((error && error.message) || error) });
    });
    return true;
  }

  if (type === 'GET_ACTIVE_TAB') {
    if (!Number.isInteger(message.windowId)) {
      sendResponse({ ok: false, reason: 'NO_TAB' });
      return undefined;
    }
    chrome.tabs
      .query({ active: true, windowId: message.windowId })
      .then((tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) {
          sendResponse({ ok: false, reason: 'NO_TAB' });
          return;
        }
        // Popup-fallback: активная вкладка — собственная extension-страница.
        // Не отдаём её как контекст; панель должна использовать tabId из URL.
        if (/^chrome-extension:/i.test(tab.url || '')) {
          sendResponse({ ok: false, reason: 'NO_TAB' });
          return;
        }
        rememberActiveTab(tab);
        sendResponse({ ok: true, tab: toTabInfo(tab) });
      })
      .catch((error) => sendResponse({ ok: false, reason: 'NO_TAB', message: String((error && error.message) || error) }));
    return true;
  }

  if (type === 'GET_TAB') {
    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId)) {
      sendResponse({ ok: false, reason: 'NO_TAB' });
      return undefined;
    }
    chrome.tabs
      .get(tabId)
      .then((tab) => sendResponse({ ok: true, tab: toTabInfo(tab) }))
      .catch(() => sendResponse({ ok: false, reason: 'NO_TAB' }));
    return true;
  }

  if (type === 'GET_PENDING_CONTEXT') {
    readPending(message.windowId)
      .then(async (context) => {
        if (context && message.clear !== false) await clearPending(context.id, message.windowId);
        sendResponse({ ok: true, context: context || null });
      })
      .catch(() => sendResponse({ ok: true, context: null }));
    return true;
  }

  if (type === 'CLEAR_PENDING_CONTEXT') {
    clearPending(message.id, message.windowId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage().catch(() => {});
    sendResponse({ ok: true });
    return undefined;
  }

  if (type === 'OPEN_PANEL') {
    if (cachedActiveTab) {
      const opened = openPanelForTab(cachedActiveTab);
      sendResponse({ ok: opened });
      return undefined;
    }
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then((tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) {
          sendResponse({ ok: false });
          return;
        }
        openPanelForTab(tab);
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (type === 'PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return undefined;
  }

  return undefined;
});

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

async function seedDefaults() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    if (!stored[STORAGE_KEYS.settings]) {
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS } });
    }
  } catch (error) {
    console.warn('[ИИ помощник] seedDefaults:', error && error.message);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  createContextMenus();
  setupSidePanelBehavior();
  seedDefaults();
  if (details && details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
  setupSidePanelBehavior();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs
    .get(tabId)
    .then(rememberActiveTab)
    .catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Только активная вкладка: фоновая догрузка не должна подменять контекст команды.
  if (!tab || tab.active !== true) return;
  if (changeInfo && (changeInfo.status === 'complete' || changeInfo.url)) rememberActiveTab(tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (cachedActiveTab && cachedActiveTab.id === tabId) cachedActiveTab = null;
});

chrome.tabs
  .query({ active: true, lastFocusedWindow: true })
  .then((tabs) => {
    if (tabs && tabs[0]) rememberActiveTab(tabs[0]);
  })
  .catch(() => {});

// Стартовое поведение (SW мог проснуться без onInstalled/onStartup).
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
createContextMenus();
setupSidePanelBehavior();
