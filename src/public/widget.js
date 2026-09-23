/*!
 * ShadowPBX Web Dialer — embeddable "Call us" widget (Phase 4)
 *
 * Drop one tag onto any page:
 *
 *   <script src="https://pbx.example.com/widget.js"
 *           data-widget="abc123"
 *           data-label="Call us"
 *           data-color="#2563eb"
 *           data-position="bottom-right" async></script>
 *
 * It renders a floating button, asks for the microphone, fetches a
 * single-use guest credential from the PBX, registers over WSS with
 * SIP.js and places the call. The visitor installs nothing and never
 * needs a phone number.
 *
 * Everything lives in a shadow root, so the host page's CSS cannot
 * reach the widget and the widget cannot leak styles onto the page.
 * SIP.js is loaded from the PBX itself — no CDN.
 */
(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) if (all[i].src && /widget\.js(\?|$)/.test(all[i].src)) return all[i];
    return null;
  })();
  if (!script) return;

  var WIDGET_ID = script.getAttribute('data-widget');
  if (!WIDGET_ID) { console.error('[ShadowPBX] data-widget is required on the widget script tag'); return; }
  if (window.__shadowpbxWidget && window.__shadowpbxWidget[WIDGET_ID]) return;   // already on the page
  window.__shadowpbxWidget = window.__shadowpbxWidget || {};
  window.__shadowpbxWidget[WIDGET_ID] = true;

  var BASE = new URL(script.src, location.href).origin;
  var SIPJS_URL = BASE + '/vendor/sip-0.21.2.min.js';
  var CFG = {
    label: script.getAttribute('data-label') || 'Call us',
    color: script.getAttribute('data-color') || '#2563eb',
    position: script.getAttribute('data-position') || 'bottom-right',
    greeting: script.getAttribute('data-greeting') || '',
    collectInfo: script.getAttribute('data-collect') || null,
    autoOpen: script.getAttribute('data-auto-open') === 'true'
  };

  // ---------------------------------------------------------------
  // Shadow DOM shell
  // ---------------------------------------------------------------
  var host = document.createElement('div');
  host.setAttribute('data-shadowpbx-widget', WIDGET_ID);
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  var vert = CFG.position.indexOf('top') === 0 ? 'top' : 'bottom';
  var horiz = CFG.position.indexOf('left') > -1 ? 'left' : 'right';

  var style = document.createElement('style');
  style.textContent = [
    ':host, * { box-sizing: border-box; }',
    '.wrap { position: fixed; ' + vert + ': 20px; ' + horiz + ': 20px; z-index: 2147483000;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
    '  font-size: 14px; line-height: 1.4; color: #111827; display: flex; flex-direction: column;',
    '  align-items: ' + (horiz === 'left' ? 'flex-start' : 'flex-end') + '; gap: 10px; }',
    '.btn { border: 0; cursor: pointer; border-radius: 999px; font: inherit; font-weight: 600;',
    '  padding: 12px 20px; color: #fff; background: var(--accent); box-shadow: 0 4px 14px rgba(0,0,0,.18);',
    '  display: inline-flex; align-items: center; gap: 8px; transition: transform .12s ease, box-shadow .12s ease; }',
    '.btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,.22); }',
    '.btn:focus-visible { outline: 3px solid rgba(37,99,235,.4); outline-offset: 2px; }',
    '.btn[disabled] { opacity: .6; cursor: default; transform: none; }',
    '.btn svg { width: 18px; height: 18px; fill: currentColor; flex: none; }',
    '.panel { width: 290px; max-width: calc(100vw - 40px); background: #fff; border-radius: 14px;',
    '  box-shadow: 0 10px 34px rgba(0,0,0,.22); overflow: hidden; display: none; }',
    '.panel.open { display: block; }',
    '.head { background: var(--accent); color: #fff; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; }',
    '.head b { font-size: 15px; font-weight: 600; }',
    '.x { background: none; border: 0; color: #fff; font-size: 20px; line-height: 1; cursor: pointer; opacity: .85; padding: 0 2px; }',
    '.x:hover { opacity: 1; }',
    '.body { padding: 16px; }',
    '.greet { color: #4b5563; margin: 0 0 12px; }',
    'label { display: block; font-size: 12px; font-weight: 600; color: #374151; margin: 0 0 4px; }',
    'input { width: 100%; padding: 9px 11px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; margin-bottom: 10px; }',
    'input:focus { outline: 0; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,.15); }',
    '.status { display: flex; align-items: center; gap: 8px; color: #4b5563; margin-bottom: 12px; }',
    '.dot { width: 9px; height: 9px; border-radius: 50%; background: #9ca3af; flex: none; }',
    '.dot.ring { background: #f59e0b; animation: pulse 1.1s infinite; }',
    '.dot.live { background: #10b981; }',
    '.dot.err { background: #ef4444; }',
    '@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }',
    '.timer { font-variant-numeric: tabular-nums; font-weight: 600; color: #111827; margin-left: auto; }',
    '.row { display: flex; gap: 8px; }',
    '.row .btn { flex: 1; justify-content: center; padding: 10px 14px; }',
    '.ghost { background: #f3f4f6; color: #374151; box-shadow: none; }',
    '.ghost:hover { background: #e5e7eb; }',
    '.danger { background: #dc2626; }',
    '.err { background: #fef2f2; color: #991b1b; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }',
    '.foot { font-size: 11px; color: #9ca3af; text-align: center; padding: 0 16px 12px; }',
    '@media (max-width: 420px) { .wrap { ' + horiz + ': 12px; ' + vert + ': 12px; } .panel { width: calc(100vw - 24px); } }',
    '@media (prefers-reduced-motion: reduce) { .btn, .dot { transition: none; animation: none; } }'
  ].join('\n');

  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.style.setProperty('--accent', CFG.color);
  wrap.innerHTML = [
    '<div class="panel" part="panel" role="dialog" aria-label="Call us">',
    '  <div class="head"><b class="t">Call us</b><button class="x" aria-label="Close">&times;</button></div>',
    '  <div class="body">',
    '    <p class="greet"></p>',
    '    <div class="err" hidden></div>',
    '    <div class="form" hidden>',
    '      <label for="spbx-name">Your name</label><input id="spbx-name" autocomplete="name">',
    '      <div class="numwrap" hidden><label for="spbx-num">Phone number</label><input id="spbx-num" type="tel" autocomplete="tel"></div>',
    '    </div>',
    '    <div class="status" hidden><span class="dot"></span><span class="txt"></span><span class="timer"></span></div>',
    '    <div class="row">',
    '      <button class="btn start">Start call</button>',
    '      <button class="btn ghost mute" hidden>Mute</button>',
    '      <button class="btn danger hang" hidden>Hang up</button>',
    '    </div>',
    '  </div>',
    '  <div class="foot">Calls through your browser — no phone needed</div>',
    '</div>',
    '<button class="btn launch">',
    '  <svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.2.4 2.4.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1l-2.3 2.2z"/></svg>',
    '  <span class="lbl"></span>',
    '</button>'
  ].join('\n');

  root.appendChild(style);
  root.appendChild(wrap);
  (document.body || document.documentElement).appendChild(host);

  var $ = function (sel) { return wrap.querySelector(sel); };
  var el = {
    panel: $('.panel'), title: $('.t'), close: $('.x'), greet: $('.greet'), error: $('.err'),
    form: $('.form'), name: $('#spbx-name'), numWrap: $('.numwrap'), num: $('#spbx-num'),
    status: $('.status'), dot: $('.dot'), txt: $('.txt'), timer: $('.timer'),
    start: $('.start'), mute: $('.mute'), hang: $('.hang'), launch: $('.launch'), label: $('.lbl')
  };
  el.label.textContent = CFG.label;
  el.title.textContent = CFG.label;

  var audio = document.createElement('audio');
  audio.autoplay = true;
  audio.setAttribute('playsinline', '');
  root.appendChild(audio);

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  var ua = null, session = null, muted = false, timer = null, started = 0, busy = false, remoteCfg = null;

  function status(text, kind) {
    el.status.hidden = false;
    el.txt.textContent = text;
    el.dot.className = 'dot' + (kind ? ' ' + kind : '');
  }
  function error(msg) {
    el.error.hidden = false;
    el.error.textContent = msg;
    status('Not connected', 'err');
  }
  function clearError() { el.error.hidden = true; el.error.textContent = ''; }

  function openPanel() {
    el.panel.classList.add('open');
    el.launch.hidden = true;
    loadConfig();
  }
  function closePanel() {
    if (session) { if (!confirm('End the call?')) return; hangup(); }
    el.panel.classList.remove('open');
    el.launch.hidden = false;
  }

  el.launch.addEventListener('click', openPanel);
  el.close.addEventListener('click', closePanel);
  el.start.addEventListener('click', startCall);
  el.hang.addEventListener('click', hangup);
  el.mute.addEventListener('click', toggleMute);

  // ---------------------------------------------------------------
  // Config (branding + whether to ask for a name)
  // ---------------------------------------------------------------
  var configLoaded = false;
  function loadConfig() {
    if (configLoaded) return;
    configLoaded = true;
    fetch(BASE + '/api/webcall/config/' + encodeURIComponent(WIDGET_ID), { mode: 'cors' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.success) throw new Error(d.error || 'Unavailable');
        remoteCfg = d;
        var b = d.branding || {};
        if (b.label) { el.label.textContent = b.label; el.title.textContent = b.label; }
        if (b.color) wrap.style.setProperty('--accent', b.color);
        el.greet.textContent = CFG.greeting || b.greeting || 'Talk to us right from your browser.';
        var collect = CFG.collectInfo || d.collectInfo || 'none';
        if (collect !== 'none') {
          el.form.hidden = false;
          el.numWrap.hidden = collect !== 'name+number';
        }
      })
      .catch(function (e) {
        el.greet.textContent = CFG.greeting || 'Talk to us right from your browser.';
        console.warn('[ShadowPBX] widget config: ' + e.message);
      });
  }

  // ---------------------------------------------------------------
  // SIP.js loader
  // ---------------------------------------------------------------
  function loadSip() {
    if (window.SIP && window.SIP.UserAgent) return Promise.resolve(window.SIP);
    if (loadSip._p) return loadSip._p;
    loadSip._p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SIPJS_URL;
      s.async = true;
      s.onload = function () { window.SIP && window.SIP.UserAgent ? resolve(window.SIP) : reject(new Error('SIP.js did not initialise')); };
      s.onerror = function () { reject(new Error('Could not load the calling library')); };
      document.head.appendChild(s);
    });
    return loadSip._p;
  }

  // ---------------------------------------------------------------
  // Placing the call
  // ---------------------------------------------------------------
  function supported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket);
  }

  async function startCall() {
    if (busy || session) return;
    clearError();

    if (!window.isSecureContext) return error('Calling needs a secure (https) page.');
    if (!supported()) return error('This browser cannot make calls. Try Chrome, Firefox, Safari or Edge.');

    busy = true;
    el.start.disabled = true;
    status('Connecting…', 'ring');

    try {
      // 1. microphone first — a refusal here should not burn a token
      var stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (e) {
        throw new Error('Microphone access was blocked. Allow it in your browser, then try again.');
      }
      stream.getTracks().forEach(function (t) { t.stop(); });   // SIP.js opens its own

      // 2. single-use credential
      var SIPLIB = await loadSip();
      var r = await fetch(BASE + '/api/webcall/token', {
        method: 'POST', mode: 'cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          widgetId: WIDGET_ID,
          pageUrl: location.href,
          name: el.name.value.trim(),
          number: el.num.value.trim()
        })
      });
      var tok = await r.json();
      if (!r.ok || !tok.success) throw new Error(tok.error || 'Calling is unavailable right now.');

      // 3. register + invite
      var uri = SIPLIB.UserAgent.makeURI('sip:' + tok.username + '@' + tok.sipDomain);
      ua = new SIPLIB.UserAgent({
        uri: uri,
        authorizationUsername: tok.username,
        authorizationPassword: tok.password,
        displayName: el.name.value.trim() || 'Web caller',
        transportOptions: { server: tok.wssUrl },
        userAgentString: 'ShadowPBX-Widget/1.0',
        logLevel: 'error',
        sessionDescriptionHandlerFactoryOptions: {
          iceGatheringTimeout: 3000,
          peerConnectionConfiguration: { iceServers: tok.iceServers || [] }
        },
        delegate: {
          onDisconnect: function () { if (session) error('The connection dropped.'); }
        }
      });

      await ua.start();

      var target = SIPLIB.UserAgent.makeURI('sip:' + tok.callTarget + '@' + tok.sipDomain);
      var inviter = new SIPLIB.Inviter(ua, target, {
        sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } }
      });
      bind(inviter, SIPLIB);

      await inviter.invite({
        requestDelegate: {
          onProgress: function (p) {
            var c = p.message.statusCode;
            if (c === 180 || c === 183) status('Ringing…', 'ring');
          },
          onReject: function (p) { rejected(p.message.statusCode); }
        }
      });

      el.hang.hidden = false;
      el.start.hidden = true;
    } catch (e) {
      error(e.message);
      cleanup();
    } finally {
      busy = false;
      el.start.disabled = false;
    }
  }

  function rejected(code) {
    if (code === 480 || code === 503) error('Nobody is available right now. Please try again shortly.');
    else if (code === 403) error('This call could not be placed from this page.');
    else if (code === 486 || code === 600) error('The line is busy. Please try again shortly.');
    else if (code === 488) error('Audio could not be set up. Please try again.');
    else error('The call could not be connected (' + code + ').');
  }

  function bind(s, SIPLIB) {
    session = s;
    s.stateChange.addListener(function (state) {
      if (state === SIPLIB.SessionState.Established) established(SIPLIB);
      if (state === SIPLIB.SessionState.Terminated) {
        if (started) status('Call ended', '');
        cleanup();
      }
    });
  }

  function established(SIPLIB) {
    var pc = session.sessionDescriptionHandler && session.sessionDescriptionHandler.peerConnection;
    if (pc) {
      var remote = new MediaStream();
      pc.getReceivers().forEach(function (r) { if (r.track) remote.addTrack(r.track); });
      audio.srcObject = remote;
      // Older Safari returns undefined rather than a promise
      var played = audio.play();
      if (played && played.catch) played.catch(function () { /* the click that started the call counts as a gesture */ });
      pc.addEventListener('iceconnectionstatechange', function () {
        if (pc.iceConnectionState === 'failed') error('The audio connection failed — your network may be blocking calls.');
      });
    }
    status('Connected', 'live');
    el.mute.hidden = false;
    el.form.hidden = true;
    started = Date.now();
    timer = setInterval(function () {
      var s = Math.floor((Date.now() - started) / 1000);
      el.timer.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
  }

  function toggleMute() {
    var pc = session && session.sessionDescriptionHandler && session.sessionDescriptionHandler.peerConnection;
    if (!pc) return;
    muted = !muted;
    pc.getSenders().forEach(function (s) { if (s.track) s.track.enabled = !muted; });
    el.mute.textContent = muted ? 'Unmute' : 'Mute';
  }

  function hangup() {
    if (!session) return cleanup();
    try {
      if (session.state === 'Established') session.bye();
      else if (typeof session.cancel === 'function') session.cancel();
      else session.reject();
    } catch (e) { /* already gone */ }
  }

  function cleanup() {
    clearInterval(timer);
    timer = null;
    session = null;
    muted = false;
    started = 0;
    audio.srcObject = null;
    el.mute.hidden = true;
    el.mute.textContent = 'Mute';
    el.hang.hidden = true;
    el.start.hidden = false;
    el.start.disabled = false;
    el.timer.textContent = '';
    if (ua) { try { ua.stop(); } catch (e) {} ua = null; }
  }

  window.addEventListener('beforeunload', function () { try { hangup(); } catch (e) {} });
  window.addEventListener('pagehide', function () { try { hangup(); } catch (e) {} });

  if (CFG.autoOpen) openPanel();

  // Minimal public handle, so a site can trigger the widget from its own button
  window.ShadowPBXWidget = window.ShadowPBXWidget || {};
  window.ShadowPBXWidget[WIDGET_ID] = { open: openPanel, close: closePanel, call: function () { openPanel(); startCall(); } };
})();
