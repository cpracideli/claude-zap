// Automated tests for WaCalls integration in bridge.mjs:
// - Auth protection on /admin/wacalls/{status,start,stop,api/*,ws}
// - HTTP proxy (GET/POST/DELETE, query string, X-Client-Id, Content-Type)
// - SSE proxy (/admin/wacalls/api/events, X-Accel-Buffering: no, Cache-Control: no-cache, live streaming)
// - Critical third-party guardrail on POST /admin/wacalls/api/sessions/:sid/calls (403 + audit.log)
// - Bidirectional binary WebSocket tunnel (/admin/wacalls/ws via Authorization header and ?token=)
// - Incoming call SSE -> Web Push notification (title, peer, url '/#/calls')
// - Supervisor start/stop with an executable fake wacalls binary

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const repoRoot = path.resolve(dir, '..');
const bridgePath = path.join(repoRoot, 'bridge', 'bridge.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal RFC 6455 helpers for raw WS client & mock server
function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function wsEncode(opcode, payloadBuf, { fin = true, mask = false } = {}) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || '');
  const b0 = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  const mBit = mask ? 0x80 : 0x00;
  let hdr;
  if (payload.length < 126) {
    hdr = Buffer.from([b0, mBit | payload.length]);
  } else if (payload.length < 65536) {
    hdr = Buffer.alloc(4);
    hdr[0] = b0; hdr[1] = mBit | 126; hdr.writeUInt16BE(payload.length, 2);
  } else {
    hdr = Buffer.alloc(10);
    hdr[0] = b0; hdr[1] = mBit | 127; hdr.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  if (!mask) return Buffer.concat([hdr, payload]);
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4];
  return Buffer.concat([hdr, key, masked]);
}

function attachFrameReader(socket, onFrame, head) {
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  const drain = () => {
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let data = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const m = buf.subarray(off, off + 4);
        data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) data[i] ^= m[i % 4];
      } else {
        data = Buffer.from(data);
      }
      buf = buf.subarray(need);
      onFrame({ fin, opcode, data });
    }
  };
  socket.on('data', (chunk) => { buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk); drain(); });
  if (buf.length) drain();
}

function connectRawWs({ port, pathAndQuery, headers = {} }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = wsAcceptKey(key);
    const socket = net.connect(port, '127.0.0.1', () => {
      const hdrLines = [
        `GET ${pathAndQuery} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(hdrLines.join('\r\n') + '\r\n\r\n');
    });
    let headerBuf = Buffer.alloc(0);
    const onData = (chunk) => {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.off('data', onData);
      const headerText = headerBuf.subarray(0, idx).toString('utf8');
      const rest = headerBuf.subarray(idx + 4);
      const statusLine = headerText.split('\r\n')[0] || '';
      const statusCode = Number(statusLine.split(' ')[1] || 0);
      if (statusCode !== 101) {
        socket.destroy();
        return resolve({ statusCode, headerText });
      }
      const acceptLine = headerText.split('\r\n').find((l) => /^sec-websocket-accept:/i.test(l)) || '';
      const acceptVal = acceptLine.split(':').slice(1).join(':').trim();
      const frames = [];
      const waiters = [];
      const notify = () => {
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i];
          const idxF = frames.findIndex(w.pred);
          if (idxF >= 0) {
            waiters.splice(i, 1);
            clearTimeout(w.timer);
            w.resolve(frames[idxF]);
          }
        }
      };
      attachFrameReader(socket, (f) => { frames.push(f); notify(); }, rest);
      resolve({
        statusCode,
        acceptValid: acceptVal === expectedAccept,
        socket,
        sendBinary(buf) { socket.write(wsEncode(2, buf, { fin: true, mask: true })); },
        close() { try { socket.end(); } catch {} },
        waitFor(pred, timeoutMs = 4000) {
          const hit = frames.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timeout waiting for WS frame')), timeoutMs);
            waiters.push({ pred, resolve: res, timer });
          });
        },
      });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

async function waitUp(url, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await wait(120);
  }
  throw new Error('timeout waiting for ' + url);
}

function listenServer(srv) {
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
}

test('WaCalls proxy HTTP/SSE, third-party 403 guardrail, binary WS tunnel and incoming Web Push', async () => {
  const tmp = path.join(dir, 'tmp-wacalls-1');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });

  // Mock panel push receiver
  const receivedPushes = [];
  const mockPanel = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      if (req.url === '/api/push/dispatch' && req.method === 'POST') {
        try { receivedPushes.push(JSON.parse(Buffer.concat(bufs).toString('utf8'))); } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const panelPort = await listenServer(mockPanel);

  // Mock WaCalls server (HTTP + SSE + binary WS)
  const upstreamHttpLogs = [];
  const upstreamWsLogs = [];
  const sseClients = new Set();
  const mockWaCalls = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('data: ' + JSON.stringify({ type: 'session-list', sessions: [{ id: 's1', name: 'Main', paired: true, state: 'open' }] }) + '\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(bufs).toString('utf8');
      upstreamHttpLogs.push({
        method: req.method,
        url: req.url,
        clientId: req.headers['x-client-id'] || '',
        contentType: req.headers['content-type'] || '',
        body: raw,
      });
      if (req.method === 'GET' && u.pathname === '/api/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sessions: [{ id: 's1', name: 'Main', paired: true, state: 'open' }] }));
      }
      if (req.method === 'POST' && u.pathname === '/api/sessions/s1/calls') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ call: { callId: 'call-123' } }));
      }
      if (req.method === 'DELETE' && u.pathname === '/api/sessions/s1/calls/call-123') {
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  mockWaCalls.on('upgrade', (req, socket, head) => {
    upstreamWsLogs.push({ url: req.url, clientId: req.headers['x-client-id'] || '' });
    const key = String(req.headers['sec-websocket-key'] || '');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '
      + wsAcceptKey(key) + '\r\n\r\n'
    );
    attachFrameReader(socket, (f) => {
      if (f.opcode === 2) {
        // Invert first byte and echo back as binary PCM proof of bidirectional tunnel
        const reply = Buffer.from(f.data);
        if (reply.length) reply[0] = reply[0] ^ 0xff;
        socket.write(wsEncode(2, reply, { fin: true, mask: false }));
      }
    }, head);
  });

  const wacallsPort = await listenServer(mockWaCalls);
  const bridgePort = 4381;
  const adminToken = 'tok-wacalls-secret';

  const bridge = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      HOME: tmp,
      PORT: String(bridgePort),
      BRIDGE_ADMIN_TOKEN: adminToken,
      PANEL_INTERNAL_URL: `http://127.0.0.1:${panelPort}`,
      ALLOWED_NUMBERS: '5519997419074',
      WHATSAPP_ALLOW_THIRD_PARTY: 'false',
      WACALLS_ENABLED: '1',
      WACALLS_PORT: String(wacallsPort),
      WACALLS_BIN: path.join(tmp, 'nonexistent-bin'),
      STARTUP_NOTICE: 'false',
      AI_MEMORY: 'off',
    },
    stdio: 'ignore',
  });

  try {
    await waitUp(`http://127.0.0.1:${bridgePort}/health`);

    const authHdr = { Authorization: `Bearer ${adminToken}` };

    // 1. Auth checks
    const unauthStatus = await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/status`);
    assert.equal(unauthStatus.status, 401);
    const unauthApi = await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/api/sessions`);
    assert.equal(unauthApi.status, 401);

    // 2. Status reflects running mock WaCalls & sessions
    const stRes = await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/status`, { headers: authHdr });
    assert.equal(stRes.status, 200);
    const st = await stRes.json();
    assert.equal(st.running, true);
    assert.equal(st.port, wacallsPort);
    assert.equal(st.sessions.length, 1);
    assert.equal(st.sessions[0].id, 's1');
    assert.equal(st.error, null);

    // 3. HTTP proxy preserves query string, X-Client-Id, Content-Type, DELETE 204
    const listRes = await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/api/sessions?filter=active`, {
      headers: { ...authHdr, 'X-Client-Id': 'op-client-7' },
    });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.sessions[0].name, 'Main');
    const lastList = upstreamHttpLogs.find((x) => x.url === '/api/sessions?filter=active');
    assert.ok(lastList, 'query string preserved');
    assert.equal(lastList.clientId, 'op-client-7');

    const delRes = await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/api/sessions/s1/calls/call-123`, {
      method: 'DELETE',
      headers: { ...authHdr, 'X-Client-Id': 'op-client-7' },
    });
    assert.equal(delRes.status, 204);

    // 4. Critical third-party guardrail: block third party with 403 + audit.log
    const beforeCallCount = upstreamHttpLogs.filter((x) => x.url === '/api/sessions/s1/calls').length;
    const blockedRes = await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/api/sessions/s1/calls`, {
      method: 'POST',
      headers: { ...authHdr, 'Content-Type': 'application/json', 'X-Client-Id': 'op-client-7' },
      body: JSON.stringify({ phone: '+55 11 99402-6755' }),
    });
    assert.equal(blockedRes.status, 403);
    const blockedJson = await blockedRes.json();
    assert.match(blockedJson.error, /bloqueado/i);
    assert.equal(
      upstreamHttpLogs.filter((x) => x.url === '/api/sessions/s1/calls').length,
      beforeCallCount,
      'blocked call must NOT reach WaCalls upstream'
    );

    // Allowed number (BR 8/9-digit variant) passes through with 200
    const allowedRes = await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/api/sessions/s1/calls`, {
      method: 'POST',
      headers: { ...authHdr, 'Content-Type': 'application/json', 'X-Client-Id': 'op-client-7' },
      body: JSON.stringify({ phone: '551997419074' }),
    });
    assert.equal(allowedRes.status, 200);
    const allowedJson = await allowedRes.json();
    assert.equal(allowedJson.call.callId, 'call-123');

    // Audit log contains both blocked and started call entries
    const auditRes = await fetch(`http://127.0.0.1:${bridgePort}/admin/audit?n=20`, { headers: authHdr });
    const auditEntries = await auditRes.json();
    assert.ok(auditEntries.some((e) => e.action === 'wacalls-call-blocked' && e.phone === '+55 11 99402-6755'));
    assert.ok(auditEntries.some((e) => e.action === 'wacalls-call-start' && e.phone === '551997419074'));

    // 5. SSE proxy streams events without buffering & sets headers
    const sseAbort = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/api/events?clientId=op-sse`, {
      headers: authHdr,
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    assert.match(sseRes.headers.get('content-type') || '', /text\/event-stream/);
    assert.equal(sseRes.headers.get('cache-control'), 'no-cache');
    assert.equal(sseRes.headers.get('x-accel-buffering'), 'no');
    const reader = sseRes.body.getReader();
    const firstChunk = await reader.read();
    const firstText = Buffer.from(firstChunk.value).toString('utf8');
    assert.match(firstText, /session-list/);

    // 6. Register push subscription and broadcast incoming event -> bridge triggers Web Push
    const subRes = await fetch(`http://127.0.0.1:${bridgePort}/admin/push/subscriptions`, {
      method: 'POST',
      headers: { ...authHdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://push.example/sub-1', keys: { p256dh: 'a', auth: 'b' } }),
    });
    assert.equal(subRes.status, 200);

    // Wait briefly to ensure bridge's internal SSE client is connected
    for (let i = 0; i < 20 && sseClients.size < 2; i++) await wait(100);
    const incomingPayload = JSON.stringify({
      type: 'incoming',
      sessionId: 's1',
      id: 'in-call-99',
      peer: '5511988887777@s.whatsapp.net',
    });
    for (const c of sseClients) c.write('data: ' + incomingPayload + '\n\n');

    // Verify proxied SSE client received the live incoming event immediately
    const secondChunk = await reader.read();
    const secondText = Buffer.from(secondChunk.value).toString('utf8');
    assert.match(secondText, /in-call-99/);
    sseAbort.abort();

    // Verify Web Push dispatched to panel
    for (let i = 0; i < 20 && receivedPushes.length === 0; i++) await wait(100);
    assert.ok(receivedPushes.length >= 1, 'expected Web Push on incoming call');
    const push = receivedPushes[0];
    assert.equal(push.title, '📞 Ligação WhatsApp');
    assert.match(push.body, /\+5511988887777/);
    assert.equal(push.url, '/#/calls');

    // 7. WebSocket tunnel (/admin/wacalls/ws) auth, validation, and bidirectional binary PCM
    const wsUnauth = await connectRawWs({ port: bridgePort, pathAndQuery: '/admin/wacalls/ws?sid=s1&callId=call-123' });
    assert.equal(wsUnauth.statusCode, 401);

    const wsBadPath = await connectRawWs({
      port: bridgePort,
      pathAndQuery: '/admin/wacalls/ws?sid=..%2Fetc&callId=call-123',
      headers: authHdr,
    });
    assert.equal(wsBadPath.statusCode, 400);

    // Connect with Authorization header
    const ws1 = await connectRawWs({
      port: bridgePort,
      pathAndQuery: '/admin/wacalls/ws?sid=s1&callId=call-123&clientId=op-ws-1',
      headers: authHdr,
    });
    assert.equal(ws1.statusCode, 101);
    assert.equal(ws1.acceptValid, true);
    const pcm1 = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    ws1.sendBinary(pcm1);
    const echo1 = await ws1.waitFor((f) => f.opcode === 2);
    assert.deepEqual(echo1.data, Buffer.from([0x12 ^ 0xff, 0x34, 0x56, 0x78]));
    ws1.close();

    // Connect with ?token= query param
    const ws2 = await connectRawWs({
      port: bridgePort,
      pathAndQuery: `/admin/wacalls/ws?sid=s1&callId=call-456&clientId=op-ws-2&token=${encodeURIComponent(adminToken)}`,
    });
    assert.equal(ws2.statusCode, 101);
    const pcm2 = Buffer.from([0xaa, 0xbb]);
    ws2.sendBinary(pcm2);
    const echo2 = await ws2.waitFor((f) => f.opcode === 2);
    assert.deepEqual(echo2.data, Buffer.from([0xaa ^ 0xff, 0xbb]));
    ws2.close();

    assert.ok(upstreamWsLogs.some((x) => x.url === '/api/sessions/s1/calls/call-123/ws?clientId=op-ws-1'));
    assert.ok(upstreamWsLogs.some((x) => x.url === '/api/sessions/s1/calls/call-456/ws?clientId=op-ws-2'));
  } finally {
    bridge.kill('SIGTERM');
    mockWaCalls.close();
    mockPanel.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('WaCalls supervisor start/stop lifecycle with executable sidecar binary', async () => {
  const tmp = path.join(dir, 'tmp-wacalls-sup');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });

  // Tiny executable node script mimicking wacalls -addr 127.0.0.1:PORT -db PATH
  const fakeBin = path.join(tmp, 'fake-wacalls');
  fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const http = require('node:http');
const args = process.argv.slice(2);
const addrIdx = args.indexOf('-addr');
const addr = addrIdx >= 0 ? args[addrIdx + 1] : '127.0.0.1:8088';
const [host, port] = addr.split(':');
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/sessions')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ sessions: [] }));
  }
  if (req.url.startsWith('/api/events')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': ok\\n\\n');
    return;
  }
  res.writeHead(404); res.end();
});
srv.listen(Number(port), host);
process.on('SIGTERM', () => { srv.close(() => process.exit(0)); setTimeout(() => process.exit(0), 200); });
`, { mode: 0o755 });

  const wacallsPort = 4388;
  const bridgePort = 4382;
  const adminToken = 'tok-sup';

  const bridge = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      HOME: tmp,
      PORT: String(bridgePort),
      BRIDGE_ADMIN_TOKEN: adminToken,
      WACALLS_ENABLED: '1',
      WACALLS_PORT: String(wacallsPort),
      WACALLS_BIN: fakeBin,
      STARTUP_NOTICE: 'false',
      AI_MEMORY: 'off',
    },
    stdio: 'ignore',
  });

  try {
    await waitUp(`http://127.0.0.1:${bridgePort}/health`);
    const authHdr = { Authorization: `Bearer ${adminToken}` };

    // Supervisor auto-starts fakeBin on boot
    let st;
    for (let i = 0; i < 25; i++) {
      st = await (await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/status`, { headers: authHdr })).json();
      if (st.running) break;
      await wait(150);
    }
    assert.equal(st.available, true);
    assert.equal(st.running, true);
    assert.equal(st.port, wacallsPort);

    // POST /admin/wacalls/stop shuts down child cleanly
    const stopped = await (await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/stop`, { method: 'POST', headers: authHdr })).json();
    assert.equal(stopped.available, true);
    assert.equal(stopped.running, false);

    // POST /admin/wacalls/start starts it back up
    const started = await (await fetch(`http://127.0.0.1:${bridgePort}/admin/wacalls/start`, { method: 'POST', headers: authHdr })).json();
    assert.equal(started.available, true);
    assert.equal(started.running, true);
  } finally {
    bridge.kill('SIGTERM');
    await wait(300);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
