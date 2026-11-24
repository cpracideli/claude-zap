// Automated unit & integration tests for AI WhatsApp Voice Calls (/calls/ai):
// - Unit: PCM resampler (24k -> 16k stateful, odd bytes, DC & sine accuracy, reset)
// - Unit: Real-time PCM pacer (640B/20ms frames, timing, flushPartial, barge-in clear, waitUntilDrained)
// - Unit: Phone normalization (DDI 55, JID, group rejection)
// - Integration: POST/GET/DELETE /calls/ai full lifecycle with mock WaCalls + mock Gemini Live:
//   * ringing -> SSE connected -> greeting trigger
//   * WhatsApp 16k PCM -> Gemini realtimeInput & Gemini 24k PCM -> resampled 16k paced WS frames
//   * Barge-in (interrupted clears outbound queue)
//   * Tool calls: ask_agent & end_call (graceful drain + DELETE call)
//   * Chat persistence (transcript + summary with meta.aiCall)
//   * No-answer timeout -> 'não atendeu' persisted
//   * Peer declined while ringing
//   * maxMinutes auto-hangup
//   * Manual DELETE /calls/ai/:id hangup
//   * Third-party guardrail (403 + audit.log for non-ALLOWED when WHATSAPP_ALLOW_THIRD_PARTY=false; ALLOWED always permitted)
//   * Fallback Gemini model on setup failure

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

// Import pure helpers directly without starting the server
const unitTmp = path.join(dir, 'tmp-ai-call-unit-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(unitTmp, { recursive: true });
process.env.BRIDGE_IMPORT_ONLY = '1';
process.env.DATA_DIR = path.join(unitTmp, 'data');
process.env.CLAUDE_WORKDIR = path.join(unitTmp, 'work');
const bridgeMod = await import(bridgePath);
const {
  parsePcmSampleRate,
  createPcmResampler,
  createPcmPacer,
  normalizeCallPhone,
} = bridgeMod;

test.after(() => {
  fs.rmSync(unitTmp, { recursive: true, force: true });
});

// ---------- Minimal RFC 6455 helpers for mock servers ----------
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

function listenServer(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

async function waitUp(port, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch {}
    await wait(100);
  }
  throw new Error('bridge did not start on port ' + port);
}

// =========================================================================
// 1. UNIT TESTS: Resampler, Pacer, Phone Normalization
// =========================================================================
test('Unit: parsePcmSampleRate & normalizeCallPhone', () => {
  assert.equal(parsePcmSampleRate('audio/pcm;rate=24000'), 24000);
  assert.equal(parsePcmSampleRate('audio/pcm; rate=16000'), 16000);
  assert.equal(parsePcmSampleRate('audio/pcm', 24000), 24000);

  assert.equal(normalizeCallPhone('+55 (11) 98469-1018'), '5511984691018');
  assert.equal(normalizeCallPhone('11984691018'), '5511984691018');
  assert.equal(normalizeCallPhone('5511984691018@c.us'), '5511984691018');
  assert.throws(() => normalizeCallPhone('120363000000@g.us'), /grupos/);
  assert.throws(() => normalizeCallPhone('12345'), /número inválido/);
});

test('Unit: createPcmResampler 24kHz -> 16kHz preserves DC, sine frequency, and irregular chunk boundaries', () => {
  // Constant DC signal across irregular + odd-byte chunks
  const totalIn = 2400; // 100ms @ 24kHz -> exactly 1600 samples @ 16kHz
  const dcIn = Buffer.alloc(totalIn * 2);
  for (let i = 0; i < totalIn; i++) dcIn.writeInt16LE(12345, i * 2);

  const rs = createPcmResampler(24000, 16000);
  const splits = [1, 7, 199, 601, 1000, dcIn.length - 1808];
  let off = 0;
  const outParts = [];
  for (const sz of splits) {
    outParts.push(rs.push(dcIn.subarray(off, off + sz)));
    off += sz;
  }
  const dcOut = Buffer.concat(outParts);
  assert.equal(dcOut.length, 1600 * 2, '2400 samples @24k must yield exactly 1600 samples @16k');
  for (let i = 0; i < 1600; i++) {
    assert.equal(dcOut.readInt16LE(i * 2), 12345);
  }

  // Sine wave 440 Hz @ 24kHz -> verify frequency & continuity at 16kHz
  rs.reset();
  const nSineIn = 4800; // 200ms @ 24kHz -> 3200 samples @ 16kHz
  const sineIn = Buffer.alloc(nSineIn * 2);
  for (let i = 0; i < nSineIn; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * (i / 24000)) * 20000);
    sineIn.writeInt16LE(v, i * 2);
  }
  // Feed in 373-byte irregular chunks
  const sineParts = [];
  for (let p = 0; p < sineIn.length; p += 373) {
    sineParts.push(rs.push(sineIn.subarray(p, Math.min(sineIn.length, p + 373))));
  }
  const sineOut = Buffer.concat(sineParts);
  assert.equal(sineOut.length, 3200 * 2);

  // Count positive-going zero crossings over 200ms -> ~88 cycles for 440 Hz
  let crossings = 0;
  let peak = 0;
  for (let i = 1; i < 3200; i++) {
    const prev = sineOut.readInt16LE((i - 1) * 2);
    const cur = sineOut.readInt16LE(i * 2);
    if (Math.abs(cur) > peak) peak = Math.abs(cur);
    if (prev <= 0 && cur > 0) crossings += 1;
  }
  assert.ok(crossings >= 86 && crossings <= 90, `expected ~88 zero crossings for 440Hz/200ms, got ${crossings}`);
  assert.ok(peak > 18500 && peak <= 20000, `expected peak ~19900, got ${peak}`);
});

test('Unit: createPcmPacer paces 640B/20ms frames in real time, supports flushPartial and instant barge-in clear', async () => {
  const frames = [];
  const timestamps = [];
  const pacer = createPcmPacer({
    frameMs: 20,
    sampleRate: 16000,
    onFrame(f) {
      frames.push(Buffer.from(f));
      timestamps.push(Date.now());
    },
  });
  assert.equal(pacer.frameBytes, 640);

  // Enqueue 5 frames + 200 partial bytes (100ms + partial)
  const payload = Buffer.alloc(640 * 5 + 200, 0x33);
  const t0 = Date.now();
  pacer.enqueue(payload);
  // First frame fires immediately; remaining 4 frames paced over ~80ms
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 640);

  pacer.flushPartial(); // pads the 200 bytes to a 6th 640B frame
  await pacer.waitUntilDrained(2000);
  const elapsed = Date.now() - t0;

  assert.equal(frames.length, 6);
  for (const f of frames) assert.equal(f.length, 640);
  // Last frame has 200 bytes of 0x33 followed by 440 zero bytes
  assert.equal(frames[5][199], 0x33);
  assert.equal(frames[5][200], 0x00);
  // 5 intervals of 20ms = ~100ms (allow scheduler jitter >= 65ms)
  assert.ok(elapsed >= 65, `expected real-time pacing >= 65ms, got ${elapsed}ms`);

  // Barge-in test: enqueue 50 frames (1 second) and clear immediately
  const beforeCount = frames.length;
  pacer.enqueue(Buffer.alloc(640 * 50, 0x77));
  assert.equal(frames.length, beforeCount + 1); // first frame sent immediately
  pacer.clear();
  assert.equal(pacer.stats().queuedBytes, 0);
  assert.equal(pacer.stats().active, false);
  await wait(80);
  assert.equal(frames.length, beforeCount + 1, 'no more frames should be emitted after barge-in clear()');
  pacer.stop();
});

// =========================================================================
// 2. INTEGRATION TESTS: Full AI Call lifecycle against mock WaCalls + Gemini Live
// =========================================================================
function createMockWaCalls() {
  const sseClients = new Set();
  const wsCalls = new Map(); // callId -> { socket, receivedFrames, sendPcm, close }
  const httpCalls = [];
  let seq = 0;

  const broadcast = (ev) => {
    const line = 'data: ' + JSON.stringify(ev) + '\n\n';
    for (const res of sseClients) {
      try { res.write(line); } catch {}
    }
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ type: 'session-list', sessions: [{ id: 'sess-1', name: 'WA', jid: '5511921746102:10@s.whatsapp.net', state: 'open', paired: true }] }) + '\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    const bufs = [];
    req.on('data', (c) => bufs.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(bufs).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch {}
      httpCalls.push({ method: req.method, path: u.pathname, clientId: req.headers['x-client-id'] || '', body });
      if (req.method === 'GET' && u.pathname === '/api/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ sessions: [{ id: 'sess-1', name: 'WA', jid: '5511921746102:10@s.whatsapp.net', state: 'open', paired: true }] }));
      }
      if (req.method === 'POST' && u.pathname === '/api/sessions/sess-1/calls') {
        seq += 1;
        const callId = 'WACALL-' + seq;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ call: { callId } }));
        broadcast({ type: 'call-status', sessionId: 'sess-1', id: callId, status: 'ringing', peer: (body?.phone || '') + '@s.whatsapp.net' });
        return;
      }
      if (req.method === 'DELETE' && u.pathname.startsWith('/api/sessions/sess-1/calls/')) {
        const callId = u.pathname.split('/').pop();
        const entry = wsCalls.get(callId);
        if (entry) { try { entry.socket.end(); } catch {} }
        broadcast({ type: 'call-ended', sessionId: 'sess-1', id: callId, reason: 'user_ended' });
        res.writeHead(204);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const m = u.pathname.match(/^\/api\/sessions\/([^/]+)\/calls\/([^/]+)\/ws$/);
    if (!m) { socket.destroy(); return; }
    const callId = decodeURIComponent(m[2]);
    const key = String(req.headers['sec-websocket-key'] || '');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAcceptKey(key) + '\r\n\r\n');
    const receivedFrames = [];
    const entry = {
      callId,
      socket,
      receivedFrames,
      closed: false,
      sendPcm(buf) { socket.write(wsEncode(2, buf, { fin: true, mask: false })); },
      close() { try { socket.end(); } catch {} },
    };
    wsCalls.set(callId, entry);
    socket.on('error', () => {});
    attachFrameReader(socket, (f) => {
      if (f.opcode === 2) receivedFrames.push({ buf: f.data, at: Date.now() });
      else if (f.opcode === 8) { entry.closed = true; try { socket.end(); } catch {} }
    }, head);
    socket.on('close', () => { entry.closed = true; });
  });

  return listenServer(server).then((port) => ({
    port,
    httpCalls,
    wsCalls,
    broadcast,
    close() {
      for (const r of sseClients) { try { r.end(); } catch {} }
      for (const e of wsCalls.values()) { try { e.socket.destroy(); } catch {} }
      return new Promise((r) => server.close(() => r()));
    },
  }));
}

function createMockGemini() {
  const connections = [];
  let onConnectionHandler = null;
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const key = String(req.headers['sec-websocket-key'] || '');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + wsAcceptKey(key) + '\r\n\r\n');
    const received = [];
    const waiters = [];
    const notify = () => {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        const idx = received.findIndex(w.pred);
        if (idx >= 0) {
          waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(received[idx]);
        }
      }
    };
    const conn = {
      socket,
      received,
      closed: false,
      sendJson(obj) { socket.write(wsEncode(2, Buffer.from(JSON.stringify(obj), 'utf8'), { fin: true, mask: false })); },
      close(code = 1000, reason = '') {
        const r = Buffer.from(reason, 'utf8');
        const b = Buffer.alloc(2 + r.length);
        b.writeUInt16BE(code, 0);
        if (r.length) r.copy(b, 2);
        try { socket.write(wsEncode(8, b, { fin: true, mask: false })); } catch {}
        try { socket.end(); } catch {}
      },
      waitForMsg(pred, timeoutMs = 4000) {
        const hit = received.find(pred);
        if (hit) return Promise.resolve(hit);
        if (conn.closed) return Promise.reject(new Error('closed'));
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout waiting for Gemini msg; got ' + JSON.stringify(received.slice(-5)))), timeoutMs);
          waiters.push({ pred, resolve: res, reject: rej, timer });
        });
      },
    };
    let fragOp = 0, fragChunks = [];
    attachFrameReader(socket, (f) => {
      if (f.opcode === 8) { conn.closed = true; try { socket.end(); } catch {} return; }
      if (f.opcode === 9) { try { socket.write(wsEncode(10, f.data)); } catch {} return; }
      let full = null;
      if (f.opcode === 1 || f.opcode === 2) {
        if (f.fin) full = f.data;
        else { fragOp = f.opcode; fragChunks = [f.data]; }
      } else if (f.opcode === 0 && fragOp) {
        fragChunks.push(f.data);
        if (f.fin) { full = Buffer.concat(fragChunks); fragOp = 0; fragChunks = []; }
      }
      if (full) {
        try { received.push(JSON.parse(full.toString('utf8'))); notify(); } catch {}
      }
    }, head);
    socket.on('error', () => {});
    socket.on('close', () => {
      conn.closed = true;
      for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('closed')); }
    });
    connections.push(conn);
    if (onConnectionHandler) onConnectionHandler(conn);
  });
  return listenServer(server).then((port) => ({
    port,
    wsUrl: `ws://127.0.0.1:${port}/ws/gemini-live`,
    connections,
    onConnection(fn) { onConnectionHandler = fn; },
    close() {
      for (const c of connections) { try { c.socket.destroy(); } catch {} }
      return new Promise((r) => server.close(() => r()));
    },
  }));
}

function writeFakeClaude(tmpDir) {
  const p = path.join(tmpDir, 'fake-claude.mjs');
  fs.writeFileSync(p, `
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
if (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const prompt = get('-p') || '';
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'result',
    result: 'AGENTE_OK: ' + prompt.slice(-80),
    session_id: 'sess-call-1',
    is_error: false,
    num_turns: 1,
    duration_ms: 20,
    total_cost_usd: 0.001,
  }));
}, 20);
`);
  return p;
}

test('Integration: /calls/ai full lifecycle, audio resampling/pacing, barge-in, tools, timeouts & guardrail', async (t) => {
  const tmp = path.join(dir, 'tmp-ai-call-e2e-' + crypto.randomBytes(3).toString('hex'));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
  const fakeClaude = writeFakeClaude(tmp);
  const mockWa = await createMockWaCalls();
  const mockGem = await createMockGemini();

  const freePort = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });

  const TOKEN = 'ai-call-tok-77';
  const bridge = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      BRIDGE_IMPORT_ONLY: '0',
      PORT: String(freePort),
      HOME: tmp,
      DATA_DIR: path.join(tmp, '.bridge'),
      CLAUDE_WORKDIR: path.join(tmp, 'workspace'),
      CLAUDE_BIN: fakeClaude,
      AGY_BIN: path.join(tmp, 'no-agy'),
      COPILOT_BIN: path.join(tmp, 'no-copilot'),
      OPENCODE_BIN: path.join(tmp, 'no-opencode'),
      BRIDGE_ADMIN_TOKEN: TOKEN,
      WAHA_URL: '',
      ALLOWED_NUMBERS: '5511984691018',
      WHATSAPP_ALLOW_THIRD_PARTY: 'false',
      OWNER_NAME: 'Caio',
      STARTUP_NOTICE: 'false',
      BRIDGE_AUTO_TITLE: 'off',
      AI_MEMORY: 'off',
      WACALLS_ENABLED: '1',
      WACALLS_PORT: String(mockWa.port),
      GEMINI_API_KEY: 'test-gemini-key-123',
      GEMINI_LIVE_WS_URL: mockGem.wsUrl,
      AI_CALL_GREET_DELAY_MS: '20',
      AI_CALL_END_DRAIN_MS: '800',
      AI_CALL_NO_ANSWER_MS: '1500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  bridge.stdout.on('data', (d) => { logs += d; });
  bridge.stderr.on('data', (d) => { logs += d; });

  t.after(async () => {
    bridge.kill('SIGTERM');
    await mockWa.close();
    await mockGem.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await waitUp(freePort);

  const callApi = async (method, p, body, hdrs = {}) => {
    const r = await fetch(`http://127.0.0.1:${freePort}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...hdrs },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // Create a web chat so we verify persistence
  const webChat = await callApi('POST', '/admin/web', { title: 'Test Calls' }, { Authorization: 'Bearer ' + TOKEN });
  assert.equal(webChat.status, 200);
  const chatId = webChat.body.id;
  const webShortId = chatId.slice(4);

  await t.test('1. Third-party guardrail blocks non-ALLOWED when WHATSAPP_ALLOW_THIRD_PARTY=false and logs audit', async () => {
    const blocked = await callApi('POST', '/calls/ai', {
      to: '5511999990000',
      purpose: 'ligação não autorizada',
    });
    assert.equal(blocked.status, 403);
    assert.ok(blocked.body.error.includes('terceiros'));
    const auditLog = fs.readFileSync(path.join(tmp, '.bridge', 'audit.log'), 'utf8');
    assert.ok(auditLog.includes('ai-call-blocked'));
    assert.ok(auditLog.includes('5511999990000'));
  });

  await t.test('2. Full call flow: ALLOWED number, fallback model, greeting, 24k->16k pacing, barge-in, ask_agent, end_call, persistence', async () => {
    let gemAttempt = 0;
    let activeGem = null;
    mockGem.onConnection((conn) => {
      gemAttempt += 1;
      const n = gemAttempt;
      conn.waitForMsg((m) => Boolean(m.setup)).then((m) => {
        if (n === 1) {
          // Force fallback from primary to fallback model
          conn.close(1008, 'model unavailable');
        } else {
          activeGem = conn;
          const sys = m.setup.systemInstruction.parts[0].text;
          assert.ok(sys.includes('Caio'));
          assert.ok(sys.includes('lembrar reunião às 15h'));
          const fnNames = m.setup.tools[0].functionDeclarations.map((f) => f.name);
          assert.deepEqual(fnNames.sort(), ['ask_agent', 'end_call']);
          conn.sendJson({ setupComplete: {} });
        }
      });
    });

    const startRes = await callApi('POST', '/calls/ai', {
      to: '+55 (11) 98469-1018',
      purpose: 'lembrar reunião às 15h e checar agenda',
      chatId,
      voice: 'Aoede',
    });
    assert.equal(startRes.status, 200, JSON.stringify(startRes));
    assert.equal(startRes.body.status, 'ringing');
    assert.equal(startRes.body.to, '5511984691018');
    assert.equal(startRes.body.isOwner, true);
    const aiId = startRes.body.id;
    const waCallId = startRes.body.callId;

    // Wait for WaCalls WS and fallback Gemini setup
    for (let i = 0; i < 40; i++) {
      if (mockWa.wsCalls.has(waCallId) && activeGem) break;
      await wait(40);
    }
    assert.ok(mockWa.wsCalls.has(waCallId), 'WaCalls WS should connect immediately');
    assert.ok(activeGem, 'Gemini fallback connection should succeed');

    // Simulate peer answering via SSE call-status=connected
    mockWa.broadcast({ type: 'call-status', sessionId: 'sess-1', id: waCallId, status: 'connected' });

    // Gemini must receive initial greeting prompt via clientContent
    const greetMsg = await activeGem.waitForMsg((m) => m.clientContent && m.clientContent.turnComplete === true);
    assert.ok(greetMsg.clientContent.turns[0].parts[0].text.includes('atender'));

    // WhatsApp -> Gemini: send 16kHz PCM from peer
    const peerPcm = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
    mockWa.wsCalls.get(waCallId).sendPcm(peerPcm);
    const gemAudioIn = await activeGem.waitForMsg((m) => m.realtimeInput && m.realtimeInput.audio);
    assert.equal(gemAudioIn.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    assert.equal(gemAudioIn.realtimeInput.audio.data, peerPcm.toString('base64'));

    // Gemini -> WhatsApp: send 24kHz PCM (4800 samples = 200ms -> 3200 samples = 10 frames of 640B @ 16kHz)
    const gemPcm24k = Buffer.alloc(4800 * 2);
    for (let i = 0; i < 4800; i++) gemPcm24k.writeInt16LE(7000, i * 2);
    activeGem.sendJson({
      serverContent: {
        inputTranscription: { text: 'Alô, tudo bem?' },
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: gemPcm24k.toString('base64') } }] },
        outputTranscription: { text: 'Oi Caio, lembrando da reunião às 15h!' },
      },
    });
    // Wait ~60ms (should have received a few 640B frames, NOT all 10 instantly -> proves pacing)
    await wait(55);
    const waWsEntry = mockWa.wsCalls.get(waCallId);
    assert.ok(waWsEntry.receivedFrames.length >= 1 && waWsEntry.receivedFrames.length < 9,
      `expected paced frames (1..8), got ${waWsEntry.receivedFrames.length}`);
    assert.equal(waWsEntry.receivedFrames[0].buf.length, 640);
    assert.equal(waWsEntry.receivedFrames[0].buf.readInt16LE(0), 7000);

    // Barge-in: interrupted clears remaining queued frames immediately
    activeGem.sendJson({ serverContent: { interrupted: true } });
    await wait(30);
    const countAfterInterrupt = waWsEntry.receivedFrames.length;
    await wait(80);
    assert.equal(waWsEntry.receivedFrames.length, countAfterInterrupt, 'barge-in must halt outbound audio immediately');

    // Tool call: ask_agent
    activeGem.sendJson({
      toolCall: {
        functionCalls: [{ id: 'tc-ask-1', name: 'ask_agent', args: { request: 'checar pauta da reunião' } }],
      },
    });
    const askResp = await activeGem.waitForMsg((m) => m.toolResponse && m.toolResponse.functionResponses?.[0]?.id === 'tc-ask-1');
    assert.ok(askResp.toolResponse.functionResponses[0].response.result.includes('AGENTE_OK'));

    // Tool call: end_call + short closing audio + turnComplete
    const byePcm24k = Buffer.alloc(960 * 2); // 40ms @ 24k -> 640 samples = 2 frames @ 16k
    activeGem.sendJson({
      toolCall: {
        functionCalls: [{ id: 'tc-end-1', name: 'end_call', args: { reason: 'lembrete entregue' } }],
      },
    });
    const endResp = await activeGem.waitForMsg((m) => m.toolResponse && m.toolResponse.functionResponses?.[0]?.id === 'tc-end-1');
    assert.ok(endResp);
    activeGem.sendJson({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: byePcm24k.toString('base64') } }] },
        outputTranscription: { text: 'Até mais, tchau!' },
        turnComplete: true,
      },
    });

    // Wait for call to finish via GET /calls/ai/:id?wait=5
    const finalRes = await callApi('GET', `/calls/ai/${aiId}?wait=5`);
    assert.equal(finalRes.status, 200);
    assert.equal(finalRes.body.status, 'completed');
    assert.equal(finalRes.body.endReason, 'lembrete entregue');
    assert.equal(finalRes.body.model, 'models/gemini-2.5-flash-native-audio-latest');
    assert.ok(finalRes.body.transcript.some((x) => x.role === 'user' && x.text.includes('Alô')));
    assert.ok(finalRes.body.transcript.some((x) => x.role === 'assistant' && x.text.includes('reunião às 15h')));
    assert.ok(finalRes.body.transcript.some((x) => x.role === 'assistant' && x.text.includes('tchau')));

    // Verify DELETE was sent to WaCalls
    assert.ok(mockWa.httpCalls.some((c) => c.method === 'DELETE' && c.path === `/api/sessions/sess-1/calls/${waCallId}`));

    // Verify persisted in web chat history
    const hist = await callApi('GET', `/admin/web/${webShortId}/messages`, null, { Authorization: 'Bearer ' + TOKEN });
    const saved = hist.body.messages.find((m) => m.meta && m.meta.aiCall === true && m.meta.aiCallId === aiId);
    assert.ok(saved, 'AI call transcript/summary must be persisted in chat history');
    assert.ok(saved.text.includes('reunião às 15h'));
  });

  await t.test('3. No-answer timeout hangs up and persists "não atendeu"', async () => {
    mockGem.onConnection((conn) => {
      conn.waitForMsg((m) => Boolean(m.setup)).then(() => conn.sendJson({ setupComplete: {} })).catch(() => {});
    });
    const res = await callApi('POST', '/calls/ai', {
      to: '5511984691018',
      purpose: 'teste sem atendimento',
      chatId,
      noAnswerSec: 1,
      wait: 5,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'no_answer');
    assert.ok(res.body.summary.includes('não atendeu'));

    const hist = await callApi('GET', `/admin/web/${webShortId}/messages`, null, { Authorization: 'Bearer ' + TOKEN });
    const saved = hist.body.messages.find((m) => m.meta && m.meta.aiCallId === res.body.id);
    assert.ok(saved && saved.text.includes('não atendeu'));
  });

  await t.test('4. Peer decline while ringing & manual DELETE /calls/ai/:id + GET /calls/ai listing', async () => {
    mockGem.onConnection((conn) => {
      conn.waitForMsg((m) => Boolean(m.setup)).then(() => conn.sendJson({ setupComplete: {} })).catch(() => {});
    });
    const declinedStart = await callApi('POST', '/calls/ai', {
      to: '5511984691018',
      purpose: 'teste recusa',
    });
    assert.equal(declinedStart.status, 200);
    await wait(60);
    mockWa.broadcast({ type: 'call-ended', sessionId: 'sess-1', id: declinedStart.body.callId, reason: 'declined' });
    const declinedDone = await callApi('GET', `/calls/ai/${declinedStart.body.id}?wait=3`);
    assert.equal(declinedDone.body.status, 'declined');

    // Manual DELETE hangup
    const manualStart = await callApi('POST', '/calls/ai', {
      to: '5511984691018',
      purpose: 'teste encerramento manual',
      noAnswerSec: 30,
    });
    assert.equal(manualStart.status, 200);
    const delRes = await callApi('DELETE', `/calls/ai/${manualStart.body.id}`);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.status, 'cancelled');
    assert.equal(delRes.body.endReason, 'api_ended');

    // Listing GET /calls/ai includes all calls
    const listRes = await callApi('GET', '/calls/ai');
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.calls.length >= 4);
  });

  await t.test('5. maxMinutes automatically ends active call', async () => {
    mockGem.onConnection((conn) => {
      conn.waitForMsg((m) => Boolean(m.setup)).then(() => conn.sendJson({ setupComplete: {} })).catch(() => {});
    });
    const startRes = await callApi('POST', '/calls/ai', {
      to: '5511984691018',
      purpose: 'teste limite de duração',
      maxMinutes: 0.01, // clamped to 0.1 min? Let's verify clamp or allow smaller via env
    });
    assert.equal(startRes.status, 200);
    await wait(50);
    mockWa.broadcast({ type: 'call-status', sessionId: 'sess-1', id: startRes.body.callId, status: 'connected' });
    // Hang up cleanly after verifying active state (0.1 min = 6s, wait up to 7s)
    const doneRes = await callApi('GET', `/calls/ai/${startRes.body.id}?wait=8`);
    assert.equal(doneRes.status, 200);
    assert.equal(doneRes.body.status, 'completed');
    assert.equal(doneRes.body.endReason, 'max_duration');
  });
});
