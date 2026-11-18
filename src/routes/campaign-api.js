'use strict';
/**
 * Public campaign API — agent availability for an outside dialler.
 *
 * Mounted BEFORE the session auth middleware, because the caller is a server,
 * not a logged-in browser: it authenticates with a bearer token scoped to one
 * ring group, queue or extension.
 *
 * Two transports for the same snapshot. REST is the floor: always there, easy
 * to curl, and what a client falls back to. The WebSocket exists because a
 * dialler pacing on a five-second-old count either stalls or abandons calls,
 * and neither is acceptable at any volume.
 */
const express = require('express');
const agentsSvc = require('../services/campaign-agents');
const logger = require('../utils/logger');

const WS_PATH = /^\/api\/campaign\/agents\/([A-Za-z0-9_-]+)\/ws$/;

// How often to re-read the snapshot and push it if it changed. Presence events
// cover talk time; this catches registrations expiring and config edits, which
// emit nothing.
const SWEEP_MS = 3000;

function createCampaignPublicRouter({ presenceHandler }) {
  const router = express.Router();

  // Express 4 does not catch a rejected promise from an async handler: the
  // request hangs instead of erroring, which from the dialler's side looks like
  // a dead PBX. Everything async here stays inside the try.
  router.get('/campaign/agents/:keyId', async (req, res) => {
    try {
      const auth = await agentsSvc.authenticate(req.params.keyId, agentsSvc.bearerFrom(req));
      if (auth.error) return res.status(auth.status).json({ error: auth.error });

      const snap = await agentsSvc.snapshot(auth.key.target, presenceHandler);
      agentsSvc.touch(auth.key.keyId, req.ip, 'rest');
      res.json({
        group: snap.group,
        target: snap.target,
        total: snap.total,
        available: snap.available,
        agents: snap.agents,
        wsUrl: wsUrlFor(req, auth.key.keyId),
        error: snap.error || undefined,
        at: new Date().toISOString(),
      });
    } catch (err) {
      logger.error(`campaign agents API: ${err.message}`);
      res.status(500).json({ error: 'could not read agent state' });
    }
  });

  return router;
}

function wsUrlFor(req, keyId) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol) === 'https' ? 'wss' : 'ws';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/campaign/agents/${keyId}/ws`;
}

/**
 * Attach the WebSocket side to the existing HTTP server.
 *
 * socket.io owns /socket.io and handles its own upgrades; this claims one
 * explicit path and ignores everything else, so the two cannot fight over a
 * connection.
 */
function attachCampaignWs({ server, presenceHandler }) {
  let WebSocketServer;
  try { ({ WebSocketServer } = require('ws')); } catch (e) {
    logger.warn('campaign API: ws package not installed — REST only, no live pushes');
    return null;
  }

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();   // { socket, key, last }

  server.on('upgrade', async (req, socket, head) => {
    const m = WS_PATH.exec((req.url || '').split('?')[0]);
    if (!m) return;                                   // not ours — leave it alone

    let auth;
    try {
      auth = await agentsSvc.authenticate(m[1], agentsSvc.bearerFrom(req));
    } catch (e) {
      // An upgrade handler that rejects takes the whole process with it.
      logger.error(`campaign API upgrade: ${e.message}`);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      return socket.destroy();
    }
    if (auth.error) {
      socket.write(`HTTP/1.1 ${auth.status} ${auth.status === 403 ? 'Forbidden' : 'Unauthorized'}\r\n\r\n`);
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ws, key: auth.key, last: '' };
      clients.add(client);
      agentsSvc.touch(auth.key.keyId, req.socket.remoteAddress, 'ws');
      logger.info(`campaign API: ${auth.key.name} connected (${auth.key.target.type}/${auth.key.target.number})`);

      ws.on('message', (raw) => {
        // Clients that cannot set headers may authenticate in-band; they are
        // already authenticated by the time they get here, so this only has to
        // not be an error. Answer pings so a keepalive scheme works.
        let msg = null;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg && msg.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch (e) {}
        }
      });
      ws.on('close', () => clients.delete(client));
      ws.on('error', () => clients.delete(client));

      push(client, true);
    });
  });

  async function push(client, force) {
    if (client.ws.readyState !== 1) return;
    try {
      const snap = await agentsSvc.snapshot(client.key.target, presenceHandler);
      const body = JSON.stringify({
        group: snap.group,
        target: snap.target,
        total: snap.total,
        available: snap.available,
        agents: snap.agents,
        error: snap.error || undefined,
        at: new Date().toISOString(),
      });
      // `at` changes every time, so compare without it.
      const fingerprint = `${snap.total}|${snap.available}|`
        + snap.agents.map((a) => `${a.id}:${a.status}`).join(',');
      if (!force && fingerprint === client.last) return;
      client.last = fingerprint;
      client.ws.send(body);
    } catch (e) { /* a failed push must not take the socket down */ }
  }

  const pushAll = () => { for (const c of clients) push(c, false); };

  // Presence changes are the ones that matter within a second.
  if (presenceHandler && presenceHandler.events) {
    presenceHandler.events.on('state', () => setImmediate(pushAll));
  }
  const sweep = setInterval(pushAll, SWEEP_MS);

  return {
    wss,
    clientCount: () => clients.size,
    close() {
      clearInterval(sweep);
      for (const c of clients) { try { c.ws.close(); } catch (e) {} }
      clients.clear();
    },
  };
}

module.exports = { createCampaignPublicRouter, attachCampaignWs, WS_PATH };
