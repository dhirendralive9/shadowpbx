// ============================================================
// ShadowPBX — CRM Screen Pop Client
//
// Floating overlay that shows CRM contact info when an inbound
// call arrives. Works on all pages. Connects to Socket.IO and
// listens for crm:screenpop events.
//
// Also handles click-to-call: any element with data-click2call
// attribute triggers an outbound call.
//
// Loaded globally via foot.ejs — no-op if Socket.IO is not
// available (e.g. login page).
// ============================================================

(function() {
  'use strict';

  // Only initialize if we have Socket.IO and user info
  if (typeof io === 'undefined') return;

  var socket;
  try { socket = io(); } catch (e) { return; }

  // Read user info from the page (set by EJS templates)
  var myExt = window.__spbxExt || '';
  var myUser = window.__spbxUser || '';
  var myRole = window.__spbxRole || '';

  // No screen pop for unauthenticated pages
  if (!myUser) return;

  // Register with chat system (screen pop uses same socket mapping)
  if (myUser) socket.emit('chat:register', myUser);

  // ── Screen Pop Container ──
  var container = document.createElement('div');
  container.id = 'crm-screenpop';
  container.className = 'sp-container sp-hidden';
  container.innerHTML = [
    '<div class="sp-header">',
    '  <div class="sp-direction" id="sp-direction"></div>',
    '  <div class="sp-close" id="sp-close" title="Dismiss">&times;</div>',
    '</div>',
    '<div class="sp-body">',
    '  <div class="sp-name" id="sp-name"></div>',
    '  <div class="sp-company" id="sp-company"></div>',
    '  <div class="sp-detail" id="sp-phone"></div>',
    '  <div class="sp-detail" id="sp-email"></div>',
    '  <div class="sp-detail" id="sp-title"></div>',
    '  <div class="sp-meta" id="sp-meta"></div>',
    '  <div class="sp-actions" id="sp-actions"></div>',
    '</div>',
    '<div class="sp-unknown sp-hidden" id="sp-unknown">',
    '  <div class="sp-unknown-text">Unknown caller</div>',
    '  <div class="sp-unknown-phone" id="sp-unknown-phone"></div>',
    '  <div class="sp-actions" id="sp-unknown-actions"></div>',
    '</div>',
  ].join('\n');
  document.body.appendChild(container);

  // ── State ──
  var currentCallId = null;
  var autoHideTimer = null;

  // ── Show screen pop ──
  socket.on('crm:screenpop', function(data) {
    // Filter: only show if this is for our extension
    if (data.targetExtension && data.targetExtension !== myExt) return;

    currentCallId = data.callId;
    clearTimeout(autoHideTimer);

    var dir = data.direction === 'outbound' ? 'Outbound' : 'Inbound';
    var dirCls = data.direction === 'outbound' ? 'sp-dir-out' : 'sp-dir-in';
    document.getElementById('sp-direction').textContent = dir + ' Call';
    document.getElementById('sp-direction').className = 'sp-direction ' + dirCls;

    if (data.matched && data.contacts && data.contacts.length > 0) {
      var c = data.contacts[0];
      document.getElementById('sp-name').textContent = c.name || 'Unknown';
      document.getElementById('sp-company').textContent = c.company || '';
      document.getElementById('sp-phone').textContent = c.phone || data.callerPhone || '';
      document.getElementById('sp-email').textContent = c.email || '';
      document.getElementById('sp-title').textContent = c.title || '';

      var metaParts = [];
      if (c.objectType) metaParts.push(c.objectType);
      if (c.provider) metaParts.push(c.provider);
      if (c.status) metaParts.push(c.status);
      document.getElementById('sp-meta').textContent = metaParts.join(' · ');

      // Actions
      var actionsHtml = '';
      if (c.crmUrl) {
        actionsHtml += '<a href="' + escHtml(c.crmUrl) + '" target="_blank" class="sp-btn sp-btn-crm">Open in CRM</a>';
      }
      if (data.contacts.length > 1) {
        actionsHtml += '<span class="sp-multi">+' + (data.contacts.length - 1) + ' more match' + (data.contacts.length > 2 ? 'es' : '') + '</span>';
      }
      document.getElementById('sp-actions').innerHTML = actionsHtml;

      // Show matched view, hide unknown view
      showEl('sp-body'); hideEl('sp-unknown');
    } else {
      // Unknown caller
      document.getElementById('sp-unknown-phone').textContent = data.callerPhone || 'Unknown number';

      // Offer to create contact (only if we have a CRM connection)
      var unknownActions = '';
      unknownActions += '<button class="sp-btn sp-btn-create" onclick="spCreateContact(\'' + escHtml(data.callerPhone || '') + '\')">Create Contact</button>';
      document.getElementById('sp-unknown-actions').innerHTML = unknownActions;

      hideEl('sp-body'); showEl('sp-unknown');
    }

    // Show the container with animation
    container.classList.remove('sp-hidden');
    container.classList.add('sp-visible');
  });

  // ── Call answered — update indicator ──
  socket.on('crm:screenpop:answered', function(data) {
    if (data.callId !== currentCallId) return;
    var dirEl = document.getElementById('sp-direction');
    if (dirEl) {
      dirEl.textContent = 'Connected';
      dirEl.className = 'sp-direction sp-dir-connected';
    }
  });

  // ── Call ended — auto-hide after 30s ──
  socket.on('crm:screenpop:ended', function(data) {
    if (data.callId !== currentCallId) return;
    var dirEl = document.getElementById('sp-direction');
    if (dirEl) {
      dirEl.textContent = 'Call Ended';
      dirEl.className = 'sp-direction sp-dir-ended';
    }
    autoHideTimer = setTimeout(function() { hideScreenPop(); }, 30000);
  });

  // ── Dismiss button ──
  document.getElementById('sp-close').addEventListener('click', function() {
    hideScreenPop();
  });

  function hideScreenPop() {
    container.classList.remove('sp-visible');
    container.classList.add('sp-hidden');
    clearTimeout(autoHideTimer);
    if (currentCallId) {
      socket.emit('crm:screenpop:dismiss', { callId: currentCallId });
      currentCallId = null;
    }
  }

  // ── Click-to-Call ──
  // Any element with data-click2call="phone_number" triggers a call
  document.addEventListener('click', function(e) {
    var el = e.target.closest('[data-click2call]');
    if (!el || !myExt) return;
    e.preventDefault();

    var phone = el.getAttribute('data-click2call');
    if (!phone) return;

    if (!confirm('Call ' + phone + ' from ext ' + myExt + '?')) return;

    socket.emit('crm:click2call', { phone: phone, extension: myExt });
    toast('Initiating call to ' + phone + '...', 'info');
  });

  socket.on('crm:click2call:started', function(data) {
    toast('Call started: ' + data.phone, 'success');
  });

  socket.on('crm:click2call:error', function(data) {
    toast('Call failed: ' + (data.error || 'Unknown error'), 'error');
  });

  // ── Create Contact from unknown caller ──
  window.spCreateContact = function(phone) {
    var name = prompt('Contact name:', '');
    if (name === null) return;

    socket.emit('crm:screenpop:createcontact', {
      phone: phone,
      name: name || '',
      configId: '',  // Server picks the first available CRM
    });
    toast('Creating contact...', 'info');
  };

  socket.on('crm:contact:created', function(data) {
    if (data.success) {
      toast('Contact created', 'success');
    } else {
      toast('Failed: ' + (data.error || 'unknown'), 'error');
    }
  });

  // ── Helpers ──
  function showEl(id) { var e = document.getElementById(id); if (e) e.classList.remove('sp-hidden'); }
  function hideEl(id) { var e = document.getElementById(id); if (e) e.classList.add('sp-hidden'); }
  function escHtml(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
})();
