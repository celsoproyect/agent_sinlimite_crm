/**
 * Embeddable web-chat widget. Loaded by a client's website via:
 *
 *   <script src="https://YOUR-DEPLOYMENT/widget.js" data-widget-key="..." async></script>
 *
 * Its look (agent name, avatar, banner image, welcome text, quick
 * questions, color) is configured in the CRM under Canales → Widget web
 * and fetched from GET /api/widget/{key}/config on load. The older
 * `data-agent-name` / `data-logo-url` attributes still work as overrides.
 *
 * Spanish only. The visitor is asked for their name once, right after
 * their first message (skippable), so the conversation lands in the
 * inbox under a real name instead of "Visitante web". The transcript is
 * kept in localStorage so a page reload doesn't wipe the chat.
 *
 * Self-contained, no build step, no dependency on the app's own React
 * bundle (this script runs on someone else's site). The API base is
 * derived from the script's own src — not window.location — so the same
 * static file works for every account and every deployment.
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
  var attrAgentName = thisScript.getAttribute('data-agent-name');
  var attrLogoUrl = thisScript.getAttribute('data-logo-url');
  var apiBase = new URL(thisScript.src).origin;
  var storageKey = 'sinlimiteia_widget_visitor_' + widgetKey;
  var nameStorageKey = 'sinlimiteia_widget_name_' + widgetKey;
  var logStorageKey = 'sinlimiteia_widget_log_' + widgetKey;
  var MAX_LOG = 60;

  var DEFAULTS = {
    agentName: 'Asistente',
    subtitle: 'Asistente virtual',
    avatarUrl: null,
    heroImageUrl: null,
    welcomeTitle: '',
    welcomeText: 'Estoy aquí para ayudarte. ¿En qué te puedo ayudar hoy?',
    quickQuestions: [],
    disclaimer: '',
    primaryColor: '#0b2d5b',
  };

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {
      /* storage blocked — the widget still works, it just forgets on reload */
    }
  }
  function load(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  fetch(apiBase + '/api/widget/' + encodeURIComponent(widgetKey) + '/config')
    .then(function (res) {
      if (res.status === 404) return null; // widget turned off → render nothing
      return res.ok ? res.json() : DEFAULTS;
    })
    .catch(function () {
      return DEFAULTS;
    })
    .then(function (cfg) {
      if (!cfg) return;
      var merged = {};
      for (var k in DEFAULTS) merged[k] = cfg[k] != null ? cfg[k] : DEFAULTS[k];
      if (attrAgentName) merged.agentName = attrAgentName;
      if (attrLogoUrl && !merged.avatarUrl) merged.avatarUrl = attrLogoUrl;
      if (document.body) mount(merged);
      else document.addEventListener('DOMContentLoaded', function () { mount(merged); });
    });

  // ------------------------------------------------------------
  // Small DOM helpers. All visible text goes through textContent, never
  // innerHTML, since it comes from the account's settings and the AI.
  // ------------------------------------------------------------
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  var ICONS = {
    restart:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    expand:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    collapse:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    send:
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
    chat:
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  };
  function iconButton(className, icon, label) {
    var b = el('button', className);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = ICONS[icon];
    return b;
  }
  function avatar(cfg, className) {
    var wrap = el('span', className);
    if (cfg.avatarUrl) {
      var img = el('img');
      img.src = cfg.avatarUrl;
      img.alt = '';
      wrap.appendChild(img);
    } else {
      wrap.appendChild(el('span', 'slw-avatar-initial', (cfg.agentName || 'A').charAt(0).toUpperCase()));
    }
    wrap.appendChild(el('span', 'slw-online-dot'));
    return wrap;
  }

  function mount(cfg) {
    var P = /^#[0-9a-f]{6}$/i.test(cfg.primaryColor) ? cfg.primaryColor : DEFAULTS.primaryColor;
    var name = cfg.agentName;
    var welcomeTitle = cfg.welcomeTitle || '¡Hola! Soy ' + name + ' 👋';
    var disclaimer =
      cfg.disclaimer || name + ' es un asistente virtual. Valide la información por los canales oficiales.';

    var visitorId = load(storageKey);
    var visitorName = load(nameStorageKey);
    // Returning visitors (already chatted, or already answered/skipped
    // the name question) are never asked again.
    var nameDone = !!(visitorId || visitorName !== null);
    var log = [];
    try {
      log = JSON.parse(load(logStorageKey) || '[]');
      if (!Array.isArray(log)) log = [];
    } catch (e) {
      log = [];
    }

    // ----------------------------------------------------------
    // Styles — everything scoped under #slw-root so nothing leaks into,
    // or gets clobbered by, the host page.
    // ----------------------------------------------------------
    var R = '#slw-root ';
    var css = [
      '#slw-root{--slw-p:' + P + ';position:fixed;bottom:20px;right:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#1c2b3a;line-height:1.4}',
      R + '*{box-sizing:border-box;margin:0;padding:0;font-family:inherit}',
      R + 'button{cursor:pointer;border:none;background:none;color:inherit;font:inherit}',
      // Launcher
      R + '.slw-launcher{display:flex;align-items:center;gap:10px;height:60px;padding:6px 20px 6px 6px;border-radius:30px;background:var(--slw-p);color:#fff;box-shadow:0 8px 24px rgba(11,45,91,.35);transition:transform .15s}',
      R + '.slw-launcher:hover{transform:translateY(-2px)}',
      R + '.slw-launcher.slw-round{width:60px;padding:0;justify-content:center}',
      R + '.slw-launcher-label{font-size:14.5px;font-weight:600;white-space:nowrap}',
      R + '.slw-avatar{position:relative;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:#e8eef7;color:var(--slw-p);font-weight:700}',
      R + '.slw-avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover}',
      R + '.slw-avatar-initial{font-size:20px}',
      R + '.slw-online-dot{position:absolute;right:0;bottom:1px;width:13px;height:13px;border-radius:50%;background:#3ccf4e;border:2px solid #fff}',
      R + '.slw-launcher .slw-avatar{width:48px;height:48px;border:2px solid rgba(255,255,255,.85)}',
      // Panel
      R + '.slw-panel{display:none;flex-direction:column;position:fixed;bottom:92px;right:20px;width:400px;height:680px;max-width:calc(100vw - 32px);max-height:calc(100vh - 112px);background:#f4f7fb;border-radius:18px;box-shadow:0 18px 50px rgba(9,30,66,.35);overflow:hidden}',
      R + '.slw-panel.slw-open{display:flex;animation:slw-in .2s ease-out}',
      R + '.slw-panel.slw-wide{width:760px;height:calc(100vh - 112px);max-height:none}',
      '@keyframes slw-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}',
      // Header
      R + '.slw-header{flex-shrink:0;display:flex;align-items:center;gap:12px;padding:14px 12px 14px 14px;background:linear-gradient(135deg,var(--slw-p),#06182f);color:#fff}',
      R + '.slw-header .slw-avatar{width:50px;height:50px;border:2px solid rgba(255,255,255,.9)}',
      R + '.slw-header-text{flex:1;min-width:0}',
      R + '.slw-name{font-size:18px;font-weight:700;line-height:1.2}',
      R + '.slw-subtitle{font-size:12.5px;opacity:.9;margin-top:2px}',
      R + '.slw-status{color:#5ee06d;font-weight:600}',
      R + '.slw-hbtn{width:34px;height:34px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;opacity:.9;flex-shrink:0}',
      R + '.slw-hbtn:hover{background:rgba(255,255,255,.12);opacity:1}',
      // Scroll body
      R + '.slw-body{flex:1;overflow-y:auto;background-color:#f4f7fb;background-image:radial-gradient(#dfe6f0 1px,transparent 1px);background-size:16px 16px}',
      // Hero
      R + '.slw-hero{position:relative;height:178px;overflow:hidden;cursor:pointer;background:radial-gradient(circle at 50% 40%,#2f63b0 0%,var(--slw-p) 55%,#06182f 100%);border-bottom:4px solid #5ec94a}',
      R + '.slw-hero img{position:absolute;left:50%;bottom:0;height:94%;max-width:90%;object-fit:contain;transform:translateX(-50%);transform-origin:50% 100%}',
      R + '.slw-hero.slw-wave img{animation:slw-wave .7s ease-in-out}',
      '@keyframes slw-wave{0%,100%{transform:translateX(-50%) rotate(0)}25%{transform:translateX(-50%) rotate(-4deg) scale(1.03)}75%{transform:translateX(-50%) rotate(4deg) scale(1.03)}}',
      R + '.slw-spark{position:absolute;color:rgba(255,255,255,.55);font-size:12px}',
      R + '.slw-touch{position:absolute;left:12px;bottom:12px;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.18);backdrop-filter:blur(4px);color:#fff;font-size:12.5px;font-weight:600}',
      // Welcome + quick questions
      R + '.slw-welcome{padding:22px 20px 6px;text-align:center}',
      R + '.slw-welcome h2{font-size:20px;font-weight:800;color:#0f2742}',
      R + '.slw-welcome p{margin-top:8px;font-size:14.5px;color:#5b6b7f}',
      R + '.slw-faq{padding:14px 14px 4px}',
      R + '.slw-faq-label{font-size:12px;font-weight:700;letter-spacing:.06em;color:#5b6b7f;margin:0 2px 10px}',
      R + '.slw-q{display:flex;align-items:center;gap:12px;width:100%;margin-bottom:10px;padding:11px 12px;border-radius:14px;background:#fff;border:1px solid #e1e7f0;box-shadow:0 1px 2px rgba(15,39,66,.05);text-align:left;font-size:14.5px;color:#1c2b3a;transition:border-color .15s,box-shadow .15s}',
      R + '.slw-q:hover{border-color:var(--slw-p);box-shadow:0 3px 10px rgba(15,39,66,.1)}',
      R + '.slw-q-icon{flex-shrink:0;width:34px;height:34px;border-radius:9px;background:#e9f0fa;display:flex;align-items:center;justify-content:center;font-size:17px}',
      // Messages
      R + '.slw-msgs{display:flex;flex-direction:column;gap:8px;padding:12px 14px 16px}',
      R + '.slw-msg{max-width:82%;padding:9px 13px;font-size:14.5px;white-space:pre-wrap;word-break:break-word}',
      R + '.slw-msg-bot{align-self:flex-start;background:#fff;border:1px solid #e1e7f0;border-radius:16px 16px 16px 4px}',
      R + '.slw-msg-user{align-self:flex-end;background:var(--slw-p);color:#fff;border-radius:16px 16px 4px 16px}',
      R + '.slw-typing{display:inline-flex;gap:4px;align-items:center;padding:13px 14px}',
      R + '.slw-typing span{width:7px;height:7px;border-radius:50%;background:#9aa8b8;animation:slw-dot 1.2s infinite}',
      R + '.slw-typing span:nth-child(2){animation-delay:.15s}',
      R + '.slw-typing span:nth-child(3){animation-delay:.3s}',
      '@keyframes slw-dot{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}',
      R + '.slw-skip{align-self:flex-start;font-size:13px;color:var(--slw-p);text-decoration:underline;padding:0 4px}',
      // Composer
      R + '.slw-foot{flex-shrink:0;padding:10px 12px 8px;background:#fff;border-top:1px solid #e6ebf2}',
      R + '.slw-form{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 16px;border:1px solid #d9e1ec;border-radius:16px;background:#fff}',
      R + '.slw-form:focus-within{border-color:var(--slw-p)}',
      R + '.slw-input{flex:1;min-width:0;border:none;outline:none;background:transparent;font-size:15px;color:#1c2b3a;padding:8px 0}',
      R + '.slw-input::placeholder{color:#8a97a8}',
      R + '.slw-send{width:42px;height:42px;border-radius:11px;background:var(--slw-p);color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s}',
      R + '.slw-send:disabled{background:#a9b8cc;cursor:default}',
      R + '.slw-disclaimer{margin-top:7px;text-align:center;font-size:11.5px;color:#8a97a8}',
      // Phones: full screen
      '@media (max-width:480px){' +
        R + '.slw-panel,' + R + '.slw-panel.slw-wide{right:0;bottom:0;width:100vw;height:100%;max-width:none;max-height:none;border-radius:0}' +
        R + '.slw-expand{display:none}' +
        '}',
    ].join('');
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // ----------------------------------------------------------
    // Markup
    // ----------------------------------------------------------
    var root = el('div');
    root.id = 'slw-root';

    var launcher = el('button', 'slw-launcher' + (attrAgentName || cfg.avatarUrl ? '' : ' slw-round'));
    launcher.type = 'button';
    launcher.setAttribute('aria-label', 'Habla con ' + name);
    if (attrAgentName || cfg.avatarUrl) {
      launcher.appendChild(avatar(cfg, 'slw-avatar'));
      launcher.appendChild(el('span', 'slw-launcher-label', 'Habla con ' + name));
    } else {
      launcher.innerHTML = ICONS.chat;
    }

    var panel = el('div', 'slw-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Chat con ' + name);

    var header = el('div', 'slw-header');
    header.appendChild(avatar(cfg, 'slw-avatar'));
    var headerText = el('div', 'slw-header-text');
    headerText.appendChild(el('div', 'slw-name', name));
    var sub = el('div', 'slw-subtitle', cfg.subtitle + ' · ');
    sub.appendChild(el('span', 'slw-status', 'En línea'));
    headerText.appendChild(sub);
    header.appendChild(headerText);
    var restartBtn = iconButton('slw-hbtn', 'restart', 'Reiniciar conversación');
    var expandBtn = iconButton('slw-hbtn slw-expand', 'expand', 'Ampliar');
    var closeBtn = iconButton('slw-hbtn', 'close', 'Cerrar');
    header.appendChild(restartBtn);
    header.appendChild(expandBtn);
    header.appendChild(closeBtn);

    var body = el('div', 'slw-body');

    var hero = null;
    if (cfg.heroImageUrl) {
      hero = el('div', 'slw-hero');
      var sparks = [[8, 18], [22, 78], [12, 90], [40, 6], [62, 88], [30, 30]];
      for (var s = 0; s < sparks.length; s++) {
        var sp = el('span', 'slw-spark', '✦');
        sp.style.top = sparks[s][0] + '%';
        sp.style.left = sparks[s][1] + '%';
        hero.appendChild(sp);
      }
      var heroImg = el('img');
      heroImg.src = cfg.heroImageUrl;
      heroImg.alt = name;
      hero.appendChild(heroImg);
      hero.appendChild(el('span', 'slw-touch', '¡Tócame! 👆'));
      body.appendChild(hero);
    }

    var welcome = el('div', 'slw-welcome');
    welcome.appendChild(el('h2', null, welcomeTitle));
    welcome.appendChild(el('p', null, cfg.welcomeText));
    body.appendChild(welcome);

    var faq = null;
    if (cfg.quickQuestions && cfg.quickQuestions.length) {
      faq = el('div', 'slw-faq');
      faq.appendChild(el('div', 'slw-faq-label', 'PREGUNTAS FRECUENTES'));
      cfg.quickQuestions.forEach(function (q) {
        var b = el('button', 'slw-q');
        b.type = 'button';
        b.appendChild(el('span', 'slw-q-icon', q.icon || '💬'));
        b.appendChild(el('span', null, q.text));
        b.addEventListener('click', function () {
          submitText(q.text);
        });
        faq.appendChild(b);
      });
      body.appendChild(faq);
    }

    var msgs = el('div', 'slw-msgs');
    body.appendChild(msgs);

    var foot = el('div', 'slw-foot');
    var form = el('form', 'slw-form');
    var input = el('input', 'slw-input');
    input.type = 'text';
    input.maxLength = 4000;
    input.autocomplete = 'off';
    var sendBtn = el('button', 'slw-send');
    sendBtn.type = 'submit';
    sendBtn.setAttribute('aria-label', 'Enviar');
    sendBtn.innerHTML = ICONS.send;
    sendBtn.disabled = true;
    form.appendChild(input);
    form.appendChild(sendBtn);
    foot.appendChild(form);
    foot.appendChild(el('div', 'slw-disclaimer', disclaimer));

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(foot);
    root.appendChild(panel);
    root.appendChild(launcher);
    document.body.appendChild(root);

    // ----------------------------------------------------------
    // Behaviour
    // ----------------------------------------------------------
    var MSG_PLACEHOLDER = 'Escríbele a ' + name + '…';
    var NAME_PLACEHOLDER = 'Escribe tu nombre…';
    var busy = false;
    var askingName = false;
    var pendingText = null;
    var skipLink = null;

    function setPlaceholder() {
      input.placeholder = askingName ? NAME_PLACEHOLDER : MSG_PLACEHOLDER;
      input.maxLength = askingName ? 120 : 4000;
    }
    setPlaceholder();

    function refreshSend() {
      sendBtn.disabled = busy || !input.value.trim();
    }
    input.addEventListener('input', refreshSend);

    function scrollDown() {
      body.scrollTop = body.scrollHeight;
    }

    function showFaq(show) {
      if (faq) faq.style.display = show ? '' : 'none';
    }

    function render(text, from) {
      var m = el('div', 'slw-msg slw-msg-' + (from === 'user' ? 'user' : 'bot'), text);
      msgs.appendChild(m);
      scrollDown();
    }

    function addMessage(text, from) {
      render(text, from);
      log.push({ from: from, text: text });
      if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
      store(logStorageKey, JSON.stringify(log));
      showFaq(false);
    }

    var typingEl = null;
    function setTyping(on) {
      if (on && !typingEl) {
        typingEl = el('div', 'slw-msg slw-msg-bot slw-typing');
        typingEl.appendChild(el('span'));
        typingEl.appendChild(el('span'));
        typingEl.appendChild(el('span'));
        msgs.appendChild(typingEl);
        scrollDown();
      } else if (!on && typingEl) {
        typingEl.remove();
        typingEl = null;
      }
    }

    // Replay the stored transcript.
    for (var i = 0; i < log.length; i++) render(log[i].text, log[i].from);
    showFaq(log.length === 0);

    function askForName() {
      askingName = true;
      setPlaceholder();
      setTyping(true);
      setTimeout(function () {
        setTyping(false);
        addMessage('Antes de responderte, ¿cómo te llamas?', 'bot');
        skipLink = el('button', 'slw-skip', 'Prefiero no decirlo');
        skipLink.type = 'button';
        skipLink.addEventListener('click', function () {
          finishName(null);
        });
        msgs.appendChild(skipLink);
        scrollDown();
        input.focus();
      }, 500);
    }

    function finishName(nameValue) {
      askingName = false;
      nameDone = true;
      visitorName = nameValue || null;
      // An empty string still records "already asked" for a skip.
      store(nameStorageKey, visitorName || '');
      if (skipLink) {
        skipLink.remove();
        skipLink = null;
      }
      setPlaceholder();
      if (pendingText) {
        var text = pendingText;
        pendingText = null;
        send(text);
      }
    }

    function submitText(raw) {
      var text = (raw || '').trim();
      if (!text || busy) return;
      if (askingName) {
        var nameValue = text.slice(0, 120);
        addMessage(nameValue, 'user');
        finishName(nameValue);
        return;
      }
      addMessage(text, 'user');
      if (!nameDone) {
        pendingText = text;
        askForName();
        return;
      }
      send(text);
    }

    function send(text) {
      busy = true;
      refreshSend();
      setTyping(true);
      fetch(apiBase + '/api/widget/' + encodeURIComponent(widgetKey) + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId: visitorId, text: text, visitorName: visitorName || undefined }),
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          setTyping(false);
          if (!result.ok) {
            addMessage('Ocurrió un error. Intenta de nuevo.', 'bot');
            return;
          }
          if (result.data.visitorId) {
            visitorId = result.data.visitorId;
            store(storageKey, visitorId);
          }
          addMessage(result.data.reply || 'Gracias por tu mensaje, te responderemos pronto.', 'bot');
        })
        .catch(function () {
          setTyping(false);
          addMessage('Ocurrió un error. Intenta de nuevo.', 'bot');
        })
        .then(function () {
          busy = false;
          refreshSend();
        });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value;
      input.value = '';
      refreshSend();
      submitText(text);
    });

    var opened = false;
    function toggle() {
      opened = !opened;
      panel.classList.toggle('slw-open', opened);
      launcher.style.display = opened && window.innerWidth <= 480 ? 'none' : '';
      if (opened) {
        // A fresh chat starts at the top (banner + welcome); an ongoing
        // one at its latest message.
        if (log.length) scrollDown();
        else body.scrollTop = 0;
        input.focus();
      }
    }
    launcher.addEventListener('click', toggle);
    closeBtn.addEventListener('click', toggle);

    var wide = false;
    expandBtn.addEventListener('click', function () {
      wide = !wide;
      panel.classList.toggle('slw-wide', wide);
      expandBtn.innerHTML = wide ? ICONS.collapse : ICONS.expand;
      expandBtn.setAttribute('aria-label', wide ? 'Reducir' : 'Ampliar');
      expandBtn.title = wide ? 'Reducir' : 'Ampliar';
    });

    // Restart clears the screen and the stored transcript; the visitor
    // keeps their identity, so the inbox thread stays the same one.
    restartBtn.addEventListener('click', function () {
      if (busy) return;
      log = [];
      store(logStorageKey, null);
      msgs.innerHTML = '';
      typingEl = null;
      skipLink = null;
      pendingText = null;
      askingName = false;
      setPlaceholder();
      showFaq(true);
      body.scrollTop = 0;
      input.focus();
    });

    if (hero) {
      hero.addEventListener('click', function () {
        hero.classList.remove('slw-wave');
        void hero.offsetWidth; // restart the animation
        hero.classList.add('slw-wave');
      });
    }
  }
})();
