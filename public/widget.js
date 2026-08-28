/**
 * Embeddable web-chat widget. Loaded by a client's website via:
 *
 *   <script src="https://YOUR-DEPLOYMENT/widget.js" data-widget-key="..." async></script>
 *
 * Optional `data-logo-url="..."` swaps the default 💬 bubble icon and
 * header icon for a client's own logo image. Optional `data-agent-name="..."`
 * turns the round icon-only bubble into an oval pill with "Chat with
 * {name}" text next to the icon.
 *
 * Self-contained, no build step, no dependency on the app's own React
 * bundle (this script runs on someone else's site, in whatever
 * environment they have). The API base is derived from the script's
 * own src — not window.location — so the exact same static file works
 * for every account and every deployment: `document.currentScript.src`
 * is always this file's own origin (the Sin Limite IA deployment),
 * regardless of which website embeds it.
 */
(function () {
  'use strict';

  var thisScript = document.currentScript;
  if (!thisScript) return;

  var widgetKey = thisScript.getAttribute('data-widget-key');
  if (!widgetKey) {
    console.error('[sinlimiteia-widget] missing data-widget-key attribute');
    return;
  }
  var logoUrl = thisScript.getAttribute('data-logo-url');
  var agentName = thisScript.getAttribute('data-agent-name');
  var apiBase = new URL(thisScript.src).origin;
  var storageKey = 'sinlimiteia_widget_visitor_' + widgetKey;

  var lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  var STRINGS = {
    en: {
      title: 'Chat with us',
      talkWith: 'Chat with',
      placeholder: 'Type a message…',
      send: 'Send',
      greeting: "Hi! How can we help you today?",
      fallback: "Thanks for your message — we'll get back to you soon.",
      error: 'Something went wrong. Please try again.',
    },
    es: {
      title: 'Chatea con nosotros',
      talkWith: 'Habla con',
      placeholder: 'Escribe un mensaje…',
      send: 'Enviar',
      greeting: '¡Hola! ¿En qué podemos ayudarte?',
      fallback: 'Gracias por tu mensaje, te responderemos pronto.',
      error: 'Ocurrió un error. Intenta de nuevo.',
    },
    ko: {
      title: '채팅 상담',
      talkWith: '상담사',
      placeholder: '메시지를 입력하세요…',
      send: '보내기',
      greeting: '안녕하세요! 무엇을 도와드릴까요?',
      fallback: '메시지 감사합니다. 곧 답변드리겠습니다.',
      error: '오류가 발생했습니다. 다시 시도해 주세요.',
    },
  };
  var t = STRINGS[lang] || STRINGS.en;

  var visitorId = null;
  try {
    visitorId = localStorage.getItem(storageKey);
  } catch (e) {
    /* private-browsing / storage blocked — fine, a new visitor id is minted server-side per message */
  }

  // ------------------------------------------------------------
  // Styles — scoped under #sinlimiteia-widget-root to avoid leaking
  // into, or being clobbered by, the host page's own CSS.
  // ------------------------------------------------------------
  var style = document.createElement('style');
  style.textContent =
    '#sinlimiteia-widget-root{position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
    '#sinlimiteia-widget-root *{box-sizing:border-box}' +
    '#sinlimiteia-widget-bubble{height:56px;border-radius:28px;background:#111b21;color:#fff;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;font-size:26px;overflow:hidden;padding:8px}' +
    '#sinlimiteia-widget-bubble.sinlimiteia-bubble-pill{width:auto;justify-content:flex-start;gap:10px;padding:6px 18px 6px 6px}' +
    '#sinlimiteia-widget-bubble:not(.sinlimiteia-bubble-pill){width:56px}' +
    '#sinlimiteia-widget-bubble-icon{width:40px;height:40px;flex-shrink:0;display:flex;align-items:center;justify-content:center}' +
    '#sinlimiteia-widget-bubble-icon img{width:100%;height:100%;object-fit:contain}' +
    '#sinlimiteia-widget-bubble-label{font-size:14px;font-weight:600;white-space:nowrap}' +
    '#sinlimiteia-widget-panel{display:none;flex-direction:column;position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 32px);height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.3);overflow:hidden}' +
    '#sinlimiteia-widget-panel.open{display:flex}' +
    '#sinlimiteia-widget-header{background:#111b21;color:#fff;padding:14px 16px;font-size:15px;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:8px}' +
    '#sinlimiteia-widget-header-title{display:flex;align-items:center;gap:8px}' +
    '#sinlimiteia-widget-header img{width:24px;height:auto;flex-shrink:0}' +
    '#sinlimiteia-widget-close{background:none;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;opacity:.8}' +
    '#sinlimiteia-widget-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f0f2f5}' +
    '.sinlimiteia-msg{max-width:80%;padding:8px 12px;border-radius:10px;font-size:13.5px;line-height:1.4;white-space:pre-wrap;word-break:break-word}' +
    '.sinlimiteia-msg-bot{align-self:flex-start;background:#fff;color:#111}' +
    '.sinlimiteia-msg-user{align-self:flex-end;background:#25d366;color:#fff}' +
    '#sinlimiteia-widget-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e9edef;background:#fff}' +
    '#sinlimiteia-widget-input{flex:1;border:1px solid #d1d7db;border-radius:20px;padding:8px 14px;font-size:13.5px;outline:none}' +
    '#sinlimiteia-widget-send{background:#111b21;color:#fff;border:none;border-radius:20px;padding:8px 16px;font-size:13px;cursor:pointer}' +
    '#sinlimiteia-widget-send:disabled{opacity:.5;cursor:default}';
  document.head.appendChild(style);

  var bubbleIcon = logoUrl ? '<img src="' + logoUrl + '" alt="" />' : '💬';
  var bubbleLabel = agentName ? t.talkWith + ' ' + agentName : null;
  var bubbleContent =
    '<span id="sinlimiteia-widget-bubble-icon">' + bubbleIcon + '</span>' +
    (bubbleLabel ? '<span id="sinlimiteia-widget-bubble-label">' + bubbleLabel + '</span>' : '');
  var bubbleAriaLabel = bubbleLabel || t.title;
  var headerTitle = logoUrl
    ? '<img src="' + logoUrl + '" alt="" /><span>' + t.title + '</span>'
    : '<span>' + t.title + '</span>';

  var root = document.createElement('div');
  root.id = 'sinlimiteia-widget-root';
  root.innerHTML =
    '<button id="sinlimiteia-widget-bubble" class="' +
    (bubbleLabel ? 'sinlimiteia-bubble-pill' : '') +
    '" aria-label="' +
    bubbleAriaLabel +
    '">' +
    bubbleContent +
    '</button>' +
    '<div id="sinlimiteia-widget-panel">' +
    '<div id="sinlimiteia-widget-header"><div id="sinlimiteia-widget-header-title">' + headerTitle + '</div><button id="sinlimiteia-widget-close" aria-label="close">✕</button></div>' +
    '<div id="sinlimiteia-widget-messages"></div>' +
    '<form id="sinlimiteia-widget-form">' +
    '<input id="sinlimiteia-widget-input" type="text" placeholder="' + t.placeholder + '" autocomplete="off" />' +
    '<button id="sinlimiteia-widget-send" type="submit">' + t.send + '</button>' +
    '</form>' +
    '</div>';
  document.body.appendChild(root);

  var bubble = document.getElementById('sinlimiteia-widget-bubble');
  var panel = document.getElementById('sinlimiteia-widget-panel');
  var closeBtn = document.getElementById('sinlimiteia-widget-close');
  var messagesEl = document.getElementById('sinlimiteia-widget-messages');
  var form = document.getElementById('sinlimiteia-widget-form');
  var input = document.getElementById('sinlimiteia-widget-input');
  var sendBtn = document.getElementById('sinlimiteia-widget-send');

  var opened = false;
  function toggle() {
    opened = !opened;
    panel.classList.toggle('open', opened);
    if (opened && messagesEl.children.length === 0) {
      appendMessage(t.greeting, 'bot');
    }
    if (opened) input.focus();
  }
  bubble.addEventListener('click', toggle);
  closeBtn.addEventListener('click', toggle);

  function appendMessage(text, from) {
    var el = document.createElement('div');
    el.className = 'sinlimiteia-msg sinlimiteia-msg-' + (from === 'user' ? 'user' : 'bot');
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendMessage(text, 'user');
    sendBtn.disabled = true;

    fetch(apiBase + '/api/widget/' + encodeURIComponent(widgetKey) + '/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: visitorId, text: text }),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          appendMessage(t.error, 'bot');
          return;
        }
        if (result.data.visitorId) {
          visitorId = result.data.visitorId;
          try {
            localStorage.setItem(storageKey, visitorId);
          } catch (e) {
            /* ignore */
          }
        }
        appendMessage(result.data.reply || t.fallback, 'bot');
      })
      .catch(function () {
        appendMessage(t.error, 'bot');
      })
      .finally(function () {
        sendBtn.disabled = false;
      });
  });
})();
