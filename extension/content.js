/** Кнопка почты и вставка текста в открытый черновик. */
(() => {
  'use strict';

  if (window.__AI_COPILOT_CONTENT__) return;
  window.__AI_COPILOT_CONTENT__ = true;

  function normalizeText(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // mail.yandex.* — потребительская почта, mail.360.yandex.* — Яндекс 360 (классический BEM-UI).
  const YANDEX_MAIL_RE = /^(?:mail\.yandex|mail\.360\.yandex)\.(?:ru|com|by|kz|com\.tr|az|co\.il|ua)$/;

  function detectSite() {
    const host = location.hostname;
    if (host === 'mail.google.com') return 'gmail';
    if (/^outlook\.(office|office365|live)\.com$/.test(host)) return 'outlook';
    if (YANDEX_MAIL_RE.test(host)) return 'yandex';
    return null;
  }

  function composerCandidates() {
    const selectors = [
      // Яндекс 360 / классическая Яндекс Почта (BEM). Если тело в iframe — fallback в буфер.
      '.mail-Compose-Body[contenteditable="true"]',
      '.mail-Compose-Body-Content[contenteditable="true"]',
      '.mail-Compose-Body [contenteditable="true"]',
      'textarea.mail-Compose-Body, .mail-Compose-Body textarea, textarea[name="send"]',
      '[class*="Compose-Body"] [contenteditable="true"]',
      'div[aria-label="Message Body"][contenteditable="true"]',
      'div[aria-label*="Message Body" i][contenteditable="true"]',
      'div[aria-label*="Message body" i][contenteditable="true"]',
      'div.Am.Al.editable[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"][aria-label*="essage" i]',
      '[data-automationid="textEditor"][contenteditable="true"]',
      '.cke_editable[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ];
    const seen = new Set();
    const out = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el) || !isUsableComposer(el)) continue;
        seen.add(el);
        out.push(el);
      }
      if (out.length) break;
    }
    return out;
  }

  function isUsableComposer(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"], [role="search"], [role="combobox"]') || el.disabled || el.readOnly) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 20) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // Исключаем поисковую строку и прочие мелкие редактируемые поля.
    const label = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('data-placeholder')].join(' ');
    if (/search|поиск|получател|адресат|кому|копия|тема письма|recipient|subject/i.test(label)) return false;
    return true;
  }

  function findComposer() {
    if (!detectSite()) return null;
    const candidates = composerCandidates();
    if (!candidates.length) return null;
    const active = candidates.find((candidate) => candidate.contains(document.activeElement));
    return active || (candidates.length === 1 ? candidates[0] : null);
  }

  function composerText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return String(el.value || '');
    return normalizeText(el.innerText || el.textContent || '');
  }

  function readComposer() {
    const el = findComposer();
    if (!el) return { ok: false, found: false, text: '', reason: 'COMPOSER_NOT_FOUND' };
    return { ok: true, found: true, text: composerText(el).slice(0, 6000), tag: el.tagName.toLowerCase() };
  }

  function placeCaretAtEnd(el) {
    try {
      el.focus({ preventScroll: false });
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      try {
        el.focus();
        return true;
      } catch {
        return false;
      }
    }
  }

  function dispatchInput(el, inserted) {
    try {
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: inserted }));
    } catch {
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } catch {
        /* ignore */
      }
    }
    try {
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      /* ignore */
    }
  }

  function composerContains(el, sample) {
    const probe = normalizeText(sample);
    if (!probe) return false;
    const current = normalizeText(composerText(el));
    return current.endsWith(probe);
  }

  function findComposerIframe() {
    // В классической Яндекс Почте/360 тело ответа может жить в iframe — из top-frame не достать.
    const selectors = [
      'iframe[id*="compose" i]',
      'iframe[class*="compose" i]',
      'iframe[name*="compose" i]',
      'iframe[src*="compose" i]',
      'iframe[class*="mail-Compose" i]',
      'iframe[id*="mail-Compose" i]',
    ];
    for (const selector of selectors) {
      let frame;
      try {
        frame = document.querySelector(selector);
      } catch {
        continue;
      }
      if (!frame) continue;
      const rect = frame.getBoundingClientRect();
      if (rect.width > 120 && rect.height > 40) return frame;
    }
    return null;
  }

  /**
   * Вставка текста в композер. Не отправляет письмо.
   * @returns {{ok:boolean, strategy?:string, reason?:string, composer?:string}}
   */
  function insertIntoComposer(rawText) {
    const content = String(rawText || '');
    if (!content.trim()) return { ok: false, reason: 'EMPTY_TEXT' };
    const el = findComposer();
    if (!el) {
      // Понятная деградация: в top-frame композера нет, но он может быть в iframe.
      return { ok: false, reason: findComposerIframe() ? 'COMPOSER_IN_IFRAME' : 'COMPOSER_NOT_FOUND' };
    }
    const existing = composerText(el);
    const prefix = existing.trim() ? '\n\n' : '';
    const payload = `${prefix}${content}`;

    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      try {
        el.focus();
        const end = String(el.value || '').length;
        el.setSelectionRange(end, end);
        const inserted = document.execCommand('insertText', false, payload);
        if (!inserted) {
          el.value = `${el.value || ''}${payload}`;
          dispatchInput(el, payload);
        }
        if (composerText(el) !== existing && composerContains(el, content)) return { ok: true, strategy: 'input-insert', composer: 'generic' };
      } catch {
        /* падаем в contenteditable-ветку не нужно — это input */
      }
      return { ok: false, reason: 'INSERT_FAILED' };
    }

    const strategies = [
      {
        name: 'execCommand-insertText',
        run: () => {
          placeCaretAtEnd(el);
          return document.execCommand('insertText', false, payload);
        },
      },
      {
        name: 'execCommand-insertHTML',
        run: () => {
          placeCaretAtEnd(el);
          const escaped = payload
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
          return document.execCommand('insertHTML', false, escaped);
        },
      },
      {
        name: 'textContent-fallback',
        run: () => {
          if (existing.trim()) return false;
          el.append(document.createTextNode(payload));
          return composerContains(el, content);
        },
      },
    ];

    for (const strategy of strategies) {
      try {
        strategy.run();
      } catch {
        continue;
      }
      if (composerText(el) !== existing && composerContains(el, content)) {
        dispatchInput(el, payload);
        return { ok: true, strategy: strategy.name, composer: detectSite() || 'generic' };
      }
    }
    return { ok: false, reason: 'INSERT_FAILED' };
  }

  let launcherHost = null;
  let launcherObserver = null;
  const LAUNCHER_STYLE = `
    :host { all: initial; }
    .wrap { font-family: "Inter Variable", "Inter", "Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif; }
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 7px 11px; border: 1px solid rgba(255,255,255,.22);
      border-radius: 6px; cursor: pointer; user-select: none;
      color: #c1c1c1; font: 600 12px/1 system-ui, sans-serif; letter-spacing: .1px;
      background: #151515;
      box-shadow: 0 4px 14px rgba(0,0,0,.28);
      transition: background .14s ease, border-color .14s ease, transform .14s ease;
    }
    .btn:hover { background: #363a46; border-color: rgba(255,255,255,.32); }
    .btn:active { transform: translateY(1px); }
    .btn:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(230,233,239,.3); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #4ec264; }
    .btn[data-state="busy"] .dot { background: #d9a441; }
    .btn[data-state="done"] .dot { background: #4ec264; }
    @media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
  `;

  function launcherPosition() {
    const site = detectSite();
    if (site === 'gmail') return { right: '22px', bottom: '104px' }; // над кнопкой «Написать»
    if (site === 'yandex') return { right: '18px', bottom: '92px' }; // не перекрывает «Написать» (она слева сверху)
    return { right: '22px', bottom: '88px' };
  }

  function mountLauncher() {
    if (!detectSite()) return;
    if (launcherHost && document.contains(launcherHost)) return;
    try {
      const host = document.createElement('div');
      host.id = 'pocherk-launcher';
      host.setAttribute('data-pocherk', 'launcher');
      const pos = launcherPosition();
      host.style.cssText = `all: initial; position: fixed; right: ${pos.right}; bottom: ${pos.bottom}; z-index: 2147483646;`;
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = LAUNCHER_STYLE;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      const button = document.createElement('button');
      button.className = 'btn';
      button.type = 'button';
      button.setAttribute('data-state', 'idle');
      button.setAttribute('aria-label', 'ИИ помощник: открыть панель');
      button.title = 'ИИ помощник — открыть панель';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const label = document.createElement('span');
      label.textContent = 'ИИ помощник';
      button.append(dot, label);
      wrap.append(button);
      shadow.append(style, wrap);
      host.addEventListener('mousedown', (event) => event.stopPropagation());
      host.addEventListener('click', (event) => event.stopPropagation());
      button.addEventListener('click', onLauncherClick);
      (document.body || document.documentElement).appendChild(host);
      launcherHost = host;
    } catch {
      launcherHost = null;
    }
  }

  async function onLauncherClick(event) {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    try {
      button.setAttribute('data-state', 'busy');
      // Кнопка только открывает панель: контент не читаем и не передаём.
      await chrome.runtime.sendMessage({ type: 'AI_COPILOT_FROM_PAGE' });
      button.setAttribute('data-state', 'done');
      setTimeout(() => button.setAttribute('data-state', 'idle'), 1200);
    } catch {
      button.setAttribute('data-state', 'idle');
    }
  }

  function removeLauncher() {
    if (launcherHost && launcherHost.parentNode) launcherHost.remove();
    launcherHost = null;
  }

  function startLauncherObserver() {
    if (launcherObserver || !document.body) return;
    launcherObserver = new MutationObserver(() => {
      if (!launcherHost?.isConnected) mountLauncher();
    });
    launcherObserver.observe(document.body, { childList: true });
  }

  function respond(fn) {
    try {
      return fn();
    } catch (error) {
      return { ok: false, reason: 'ERROR', message: String((error && error.message) || error) };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== 'content') return undefined;
    switch (message.type) {
      case 'PING':
        sendResponse({ ok: true, version: chrome.runtime.getManifest().version, site: detectSite(), isMail: !!detectSite() });
        return undefined;
      case 'GET_COMPOSER':
        sendResponse(respond(readComposer));
        return undefined;
      case 'INSERT_TEXT':
        sendResponse(respond(() => insertIntoComposer(message.text)));
        return undefined;
      default:
        sendResponse({ ok: false, reason: 'UNKNOWN_TYPE' });
        return undefined;
    }
  });

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  if (detectSite()) {
    mountLauncher();
    startLauncherObserver();
  }
})();
