// Automated tests for Gemini Live full-duplex voice call support in bridge.mjs:
// - GET /admin/voice/status (auth + API key priority: vault > env > ~/.config/gemini/api_key)
// - WS /admin/voice/ws handshake (401 without token, 101 with token)
// - Zero-dep RFC 6455 framing (text, binary, fragmented text/binary, large >65535B, ping/pong payload echo, keepalive)
// - Gemini Live upstream protocol (setup, fallback model, binary audio in/out, text/audio_end, transcriptions, interrupted, turn_complete)
// - Tool calling (ask_agent -> bridge runner -> toolResponse + client tool status events)
// - Session resumption (sessionResumptionUpdate + goAway + unexpected drop reconnect)
// - Chat history persistence (webHistory + SSE events with meta.voiceCall)

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const bridgePath = path.resolve(dir, '..', 'bridge', 'bridge.mjs');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Minimal RFC 6455 helpers for raw WS client & mock Gemini Live WS server ----------
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
    const expectedAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
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
          const foundIdx = frames.findIndex(w.pred);
          if (foundIdx >= 0) {
            waiters.splice(i, 1);
            clearTimeout(w.timer);
            w.resolve(frames[foundIdx]);
          }
        }
      };
      attachFrameReader(socket, (f) => {
        if (f.opcode === 1) {
          try { f.json = JSON.parse(f.data.toString('utf8')); } catch {}
        }
        frames.push(f);
        notify();
      }, rest);
      const client = {
        statusCode,
        acceptValid: acceptVal === expectedAccept,
        socket,
        frames,
        sendText(obj) {
          const str = typeof obj === 'string' ? obj : JSON.stringify(obj);
          socket.write(wsEncode(1, Buffer.from(str, 'utf8'), { fin: true, mask: true }));
        },
        sendBinary(buf) {
          socket.write(wsEncode(2, buf, { fin: true, mask: true }));
        },
        sendRawFrame(opcode, buf, opts = {}) {
          socket.write(wsEncode(opcode, buf, { mask: true, ...opts }));
        },
        close(code = 1000) {
          const b = Buffer.alloc(2);
          b.writeUInt16BE(code, 0);
          try { socket.write(wsEncode(8, b, { fin: true, mask: true })); } catch {}
          try { socket.end(); } catch {}
        },
        waitFor(pred, timeoutMs = 4000) {
          const existing = frames.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const idxW = waiters.findIndex((x) => x.resolve === res);
              if (idxW >= 0) waiters.splice(idxW, 1);
              rej(new Error('timeout waiting for WS frame; got ' + JSON.stringify(frames.map((f) => ({ op: f.opcode, json: f.json, len: f.data.length })))));
            }, timeoutMs);
            waiters.push({ pred, resolve: res, timer });
          });
        },
      };
      resolve(client);
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

function createMockGeminiServer() {
  const connections = [];
  let onConnectionHandler = null;
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const key = String(req.headers['sec-websocket-key'] || '');
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const url = new URL(req.url || '/', 'http://local');
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
      url,
      apiKey: url.searchParams.get('key') || '',
      socket,
      received,
      closed: false,
      // Real Gemini Live often sends JSON payloads inside binary WS frames (opcode 2)
      sendJson(obj, { asBinary = true } = {}) {
        const buf = Buffer.from(JSON.stringify(obj), 'utf8');
        socket.write(wsEncode(asBinary ? 2 : 1, buf, { fin: true, mask: false }));
      },
      close(code = 1000, reason = '') {
        const r = Buffer.from(reason, 'utf8');
        const b = Buffer.alloc(2 + r.length);
        b.writeUInt16BE(code, 0);
        if (r.length) r.copy(b, 2);
        try { socket.write(wsEncode(8, b, { fin: true, mask: false })); } catch {}
        try { socket.end(); } catch {}
      },
      waitForMsg(pred, timeoutMs = 4000) {
        const existing = received.find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idxW = waiters.findIndex((x) => x.resolve === res);
            if (idxW >= 0) waiters.splice(idxW, 1);
            rej(new Error('timeout waiting for upstream msg; got ' + JSON.stringify(received)));
          }, timeoutMs);
          waiters.push({ pred, resolve: res, timer });
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
    socket.on('close', () => { conn.closed = true; });
    connections.push(conn);
    if (onConnectionHandler) onConnectionHandler(conn);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        wsUrl: `ws://127.0.0.1:${port}/ws/gemini-live`,
        connections,
        onConnection(fn) { onConnectionHandler = fn; },
        close() {
          for (const c of connections) { try { c.socket.destroy(); } catch {} }
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

async function waitUp(port, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch {}
    await wait(120);
  }
  throw new Error('bridge did not start on port ' + port);
}

function writeFakeClaude(tmpDir) {
  const fakeClaude = path.join(tmpDir, 'fake-claude.mjs');
  fs.writeFileSync(fakeClaude, `
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
if (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const p = get('-p') || '';
const sys = get('--append-system-prompt') || '';
const botMatch = sys.match(/você é o bot "([^"]+)"/);
const botName = botMatch ? botMatch[1] : 'default';
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'result',
    result: 'TOOL_RESULT(bot=' + botName + '): ' + p.slice(-160),
    session_id: 'sess-voice-1',
    is_error: false,
    num_turns: 1,
    duration_ms: 50,
    total_cost_usd: 0.001,
  }));
}, 30);
`);
  return fakeClaude;
}

test('Gemini Live voice bridge end-to-end', async (t) => {
  const tmp = path.join(dir, 'tmp-voice-live-' + crypto.randomBytes(3).toString('hex'));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
  const fakeClaude = writeFakeClaude(tmp);
  const mockGemini = await createMockGeminiServer();

  // Pick free port for bridge
  const freePort = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });

  const TOKEN = 'voice-test-tok-99';
  const bridgeEnv = {
    ...process.env,
    PORT: String(freePort),
    HOME: tmp,
    XDG_CONFIG_HOME: path.join(tmp, '.config'),
    CLAUDE_BIN: fakeClaude,
    AGY_BIN: path.join(tmp, 'no-agy'),
    COPILOT_BIN: path.join(tmp, 'no-copilot'),
    OPENCODE_BIN: path.join(tmp, 'no-opencode'),
    BRIDGE_ADMIN_TOKEN: TOKEN,
    WAHA_URL: '',
    ALLOWED_NUMBERS: '',
    STARTUP_NOTICE: 'false',
    BRIDGE_AUTO_TITLE: 'off',
    AI_MEMORY: 'off',
    GEMINI_API_KEY: '',
    GEMINI_LIVE_WS_URL: mockGemini.wsUrl,
    GEMINI_LIVE_PING_MS: '600',
    GEMINI_LIVE_RECONNECT_BASE_MS: '80',
    GEMINI_LIVE_TOOL_TIMEOUT_MS: '10000',
  };
  const bridge = spawn(process.execPath, [bridgePath], { env: bridgeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  bridge.stdout.on('data', (d) => { logs += d; });
  bridge.stderr.on('data', (d) => { logs += d; });

  t.after(async () => {
    bridge.kill('SIGTERM');
    await mockGemini.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await waitUp(freePort);

  const api = async (method, p, body, tok = TOKEN) => {
    const r = await fetch(`http://127.0.0.1:${freePort}/admin${p}`, {
      method,
      headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  await t.test('1. /admin/voice/status auth and API key resolution priority', async () => {
    const unauth = await api('GET', '/voice/status', null, 'wrong');
    assert.equal(unauth.status, 401);

    const noKey = await api('GET', '/voice/status');
    assert.equal(noKey.status, 200);
    assert.equal(noKey.body.realtime, false);
    assert.equal(noKey.body.provider, 'gemini-live');
    assert.equal(noKey.body.model, 'models/gemini-3.8-live');
    assert.equal(noKey.body.voice, 'Kore');
    assert.equal(noKey.body.hasKey, false);
    assert.ok(noKey.body.reason && noKey.body.reason.length > 5);

    // Key from ~/.config/gemini/api_key
    fs.mkdirSync(path.join(tmp, '.config', 'gemini'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.config', 'gemini', 'api_key'), '  file-key-123  \n');
    const fromFile = await api('GET', '/voice/status');
    assert.equal(fromFile.status, 200);
    assert.equal(fromFile.body.realtime, true);
    assert.equal(fromFile.body.hasKey, true);
    assert.equal(fromFile.body.reason, undefined);
  });

  await t.test('2. /admin/voice/ws rejects unauthorized (401) and upgrades authorized (101)', async () => {
    const bad = await connectRawWs({ port: freePort, pathAndQuery: '/admin/voice/ws' });
    assert.equal(bad.statusCode, 401);

    const badTok = await connectRawWs({
      port: freePort,
      pathAndQuery: '/admin/voice/ws',
      headers: { Authorization: 'Bearer nope' },
    });
    assert.equal(badTok.statusCode, 401);
  });

  // Create a specialist bot + web chat with prior message so we verify context & persistence
  const infraBot = await api('POST', '/bots', { name: 'Infra', description: 'Servidores e Coolify', instructions: 'Cuide de infra.' });
  assert.equal(infraBot.status, 200);
  const createdChat = await api('POST', '/web', { title: 'Nova conversa' });
  assert.equal(createdChat.status, 200);
  const chatId = createdChat.body.id; // web:xxxx
  const webShortId = chatId.slice(4);

  // Seed one prior turn in web chat history via /admin/web/:id/messages
  await api('POST', `/web/${webShortId}/messages`, { text: 'contexto anterior importante' });
  for (let i = 0; i < 30; i++) {
    const h = await api('GET', `/web/${webShortId}/messages`);
    if (h.body.messages.length >= 2) break;
    await wait(100);
  }

  // Save gemini_api_key in vault to verify vault takes priority over ~/.config/gemini/api_key
  const saveSec = await api('POST', '/secrets', { name: 'gemini_api_key', label: 'Gemini', value: 'vault-key-999' });
  assert.equal(saveSec.status, 200);

  await t.test('3. Full-duplex bridge: setup, RFC 6455 framing, binary audio, transcriptions, interrupted, toolCall, persistence', async () => {
    let upstreamConn = null;
    mockGemini.onConnection((conn) => {
      upstreamConn = conn;
      conn.waitForMsg((m) => Boolean(m.setup)).then(() => {
        conn.sendJson({ setupComplete: {} }, { asBinary: true });
      });
    });

    // Listen to SSE on web chat to verify live emission of persisted voice transcripts
    const sseEvents = [];
    const sseReq = http.get(`http://127.0.0.1:${freePort}/admin/web/${webShortId}/events`, {
      headers: { Authorization: 'Bearer ' + TOKEN },
    }, (res) => {
      let sBuf = '';
      res.on('data', (d) => {
        sBuf += d;
        let idx;
        while ((idx = sBuf.indexOf('\n\n')) !== -1) {
          const chunk = sBuf.slice(0, idx);
          sBuf = sBuf.slice(idx + 2);
          if (chunk.startsWith('data: ')) {
            try { sseEvents.push(JSON.parse(chunk.slice(6))); } catch {}
          }
        }
      });
    });

    const client = await connectRawWs({
      port: freePort,
      pathAndQuery: `/admin/voice/ws?chatId=${encodeURIComponent(chatId)}&lang=pt-BR&voice=Aoede`,
      headers: { Authorization: 'Bearer ' + TOKEN },
    });
    assert.equal(client.statusCode, 101);
    assert.equal(client.acceptValid, true);

    // Wait for ready event
    const readyFrame = await client.waitFor((f) => f.opcode === 1 && f.json && f.json.type === 'ready');
    assert.deepEqual(readyFrame.json, {
      type: 'ready',
      model: 'models/gemini-3.8-live',
      voice: 'Aoede',
      sampleRateIn: 16000,
      sampleRateOut: 24000,
    });

    // Verify vault key priority & setup payload contents
    assert.equal(upstreamConn.apiKey, 'vault-key-999');
    const setupMsg = upstreamConn.received.find((m) => m.setup);
    assert.ok(setupMsg);
    assert.equal(setupMsg.setup.model, 'models/gemini-3.8-live');
    assert.deepEqual(setupMsg.setup.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(setupMsg.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
    const sysText = setupMsg.setup.systemInstruction.parts[0].text;
    assert.ok(sysText.includes('contexto anterior importante'), 'systemInstruction must include recent chat messages');
    assert.ok(sysText.includes('ask_agent'), 'systemInstruction must describe ask_agent');
    assert.equal(setupMsg.setup.tools[0].functionDeclarations[0].name, 'ask_agent');

    // JSON ping -> pong
    client.sendText({ type: 'ping' });
    const jsonPong = await client.waitFor((f) => f.opcode === 1 && f.json && f.json.type === 'pong');
    assert.equal(typeof jsonPong.json.ts, 'number');

    // RFC 6455 control ping (opcode 9) with payload -> pong (opcode 10) with EXACT same payload
    const pingPayload = Buffer.from('hello-ping-42');
    client.sendRawFrame(9, pingPayload, { fin: true });
    const wsPong = await client.waitFor((f) => f.opcode === 10 && f.data.equals(pingPayload));
    assert.ok(wsPong);

    // Server keepalive ping (opcode 9) arrives within ~600ms
    const serverPing = await client.waitFor((f) => f.opcode === 9, 2500);
    assert.ok(serverPing);

    // Client binary PCM16 -> Gemini realtimeInput.audio
    const pcmIn = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x7f, 0x80, 0xff, 0x00]);
    client.sendBinary(pcmIn);
    const audioInMsg = await upstreamConn.waitForMsg((m) => m.realtimeInput && m.realtimeInput.audio);
    assert.equal(audioInMsg.realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    assert.equal(audioInMsg.realtimeInput.audio.data, pcmIn.toString('base64'));

    // Fragmented large binary frame (> 65535 bytes!) with interleaved control ping
    const bigPcm = crypto.randomBytes(70000);
    client.sendRawFrame(2, bigPcm.subarray(0, 20000), { fin: false });
    client.sendRawFrame(9, Buffer.from('mid-frag'), { fin: true }); // interleaved ping!
    client.sendRawFrame(0, bigPcm.subarray(20000, 50000), { fin: false });
    client.sendRawFrame(0, bigPcm.subarray(50000), { fin: true });
    const midPong = await client.waitFor((f) => f.opcode === 10 && f.data.toString() === 'mid-frag');
    assert.ok(midPong);
    const bigInMsg = await upstreamConn.waitForMsg(
      (m) => m.realtimeInput && m.realtimeInput.audio && m.realtimeInput.audio.data === bigPcm.toString('base64')
    );
    assert.ok(bigInMsg);

    // Fragmented text JSON frame ({ type: "audio_end" })
    const audioEndStr = JSON.stringify({ type: 'audio_end' });
    client.sendRawFrame(1, Buffer.from(audioEndStr.slice(0, 8)), { fin: false });
    client.sendRawFrame(0, Buffer.from(audioEndStr.slice(8)), { fin: true });
    const endMsg = await upstreamConn.waitForMsg((m) => m.realtimeInput && m.realtimeInput.audioStreamEnd === true);
    assert.ok(endMsg);

    // Upstream transcripts + binary PCM24k audio out + turnComplete
    upstreamConn.sendJson({ serverContent: { inputTranscription: { text: 'Oi, ' } } });
    upstreamConn.sendJson({ serverContent: { inputTranscription: { text: 'como está o servidor?' } } });

    const pcmOut = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50, 0x60]);
    upstreamConn.sendJson({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcmOut.toString('base64') } }],
        },
        outputTranscription: { text: 'Tudo ' },
      },
    });
    upstreamConn.sendJson({
      serverContent: {
        outputTranscription: { text: 'ótimo por aqui!' },
        turnComplete: true,
      },
    });

    const outBin = await client.waitFor((f) => f.opcode === 2 && f.data.equals(pcmOut));
    assert.ok(outBin);
    const finalUser = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'transcript' && f.json.role === 'user' && f.json.final === true);
    assert.equal(finalUser.json.text, 'Oi, como está o servidor?');
    assert.equal(finalUser.json.delta, false);
    const finalAsst = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'transcript' && f.json.role === 'assistant' && f.json.final === true);
    assert.equal(finalAsst.json.text, 'Tudo ótimo por aqui!');
    assert.equal(finalAsst.json.delta, false);
    const turnDone = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'turn_complete');
    assert.ok(turnDone);

    // Check delta chunks were emitted too
    assert.ok(client.frames.some((f) => f.json?.type === 'transcript' && f.json.role === 'user' && f.json.delta === true && f.json.text === 'Oi, '));
    assert.ok(client.frames.some((f) => f.json?.type === 'transcript' && f.json.role === 'assistant' && f.json.delta === true && f.json.text === 'Tudo '));

    // Verify persistence in chat history & SSE emission
    const histAfter = await api('GET', `/web/${webShortId}/messages`);
    const msgs = histAfter.body.messages;
    const savedUser = msgs.find((m) => m.role === 'user' && m.text === 'Oi, como está o servidor?');
    const savedAsst = msgs.find((m) => m.role === 'assistant' && m.text === 'Tudo ótimo por aqui!');
    assert.ok(savedUser && savedUser.meta && savedUser.meta.voiceCall === true, 'user voice transcript persisted with meta.voiceCall');
    assert.ok(savedAsst && savedAsst.meta && savedAsst.meta.voiceCall === true && savedAsst.provider === 'gemini-live', 'assistant voice transcript persisted');
    assert.ok(sseEvents.some((e) => e.type === 'message' && e.message && e.message.text === 'Tudo ótimo por aqui!'), 'SSE emitted persisted voice message');

    // Interruption event
    upstreamConn.sendJson({ serverContent: { interrupted: true } });
    const intFrame = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'interrupted');
    assert.ok(intFrame);

    // Client text -> clientContent
    client.sendText({ type: 'text', text: 'Cheque a infra agora' });
    const ccMsg = await upstreamConn.waitForMsg((m) => m.clientContent && m.clientContent.turnComplete === true);
    assert.equal(ccMsg.clientContent.turns[0].parts[0].text, 'Cheque a infra agora');

    // Tool call (ask_agent) -> executes specialist bot -> returns toolResponse + emits tool events
    upstreamConn.sendJson({
      toolCall: {
        functionCalls: [{
          id: 'call-infra-1',
          name: 'ask_agent',
          args: { request: 'verificar containers coolify', bot: infraBot.body.id },
        }],
      },
    });
    const toolRunning = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'tool' && f.json.status === 'running');
    assert.equal(toolRunning.json.name, 'ask_agent');
    assert.equal(toolRunning.json.detail, 'verificar containers coolify');

    const toolResp = await upstreamConn.waitForMsg((m) => m.toolResponse && m.toolResponse.functionResponses);
    assert.equal(toolResp.toolResponse.functionResponses[0].id, 'call-infra-1');
    assert.equal(toolResp.toolResponse.functionResponses[0].name, 'ask_agent');
    assert.ok(
      toolResp.toolResponse.functionResponses[0].response.result.includes('TOOL_RESULT(bot=Infra)'),
      'unexpected tool result: ' + JSON.stringify(toolResp.toolResponse.functionResponses[0].response)
    );

    const toolDone = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'tool' && f.json.status === 'done');
    assert.equal(toolDone.json.name, 'ask_agent');

    client.close(1000);
    sseReq.destroy();
    await wait(120);
    assert.equal(upstreamConn.closed, true, 'closing client must close upstream Gemini WS cleanly');
  });

  await t.test('4. Fallback model when primary model fails during setup', async () => {
    let attempt = 0;
    mockGemini.onConnection((conn) => {
      attempt += 1;
      const myAttempt = attempt;
      conn.waitForMsg((m) => Boolean(m.setup)).then((m) => {
        if (myAttempt === 1) {
          assert.equal(m.setup.model, 'models/gemini-3.8-live');
          conn.close(1008, 'model not available');
        } else {
          assert.equal(m.setup.model, 'models/gemini-2.5-flash-native-audio-latest');
          conn.sendJson({ setupComplete: {} });
        }
      });
    });

    const client = await connectRawWs({
      port: freePort,
      pathAndQuery: '/admin/voice/ws',
      headers: { Authorization: 'Bearer ' + TOKEN },
    });
    const ready = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'ready');
    assert.equal(ready.json.model, 'models/gemini-2.5-flash-native-audio-latest');
    assert.equal(attempt, 2);
    client.close(1000);
    await wait(80);
  });

  await t.test('5. Session resumption on goAway and unexpected upstream drop', async () => {
    let connCount = 0;
    const receivedHandles = [];
    let activeUpstreams = [];
    mockGemini.onConnection((conn) => {
      connCount += 1;
      activeUpstreams.push(conn);
      conn.waitForMsg((m) => Boolean(m.setup)).then((m) => {
        receivedHandles.push(m.setup.sessionResumption?.handle || '');
        conn.sendJson({ setupComplete: {} });
        if (connCount === 1) {
          conn.sendJson({ sessionResumptionUpdate: { newHandle: 'handle-alpha-1', resumable: true } });
          setTimeout(() => conn.sendJson({ goAway: { timeLeft: '2s' } }), 40);
        } else if (connCount === 2) {
          conn.sendJson({ sessionResumptionUpdate: { newHandle: 'handle-beta-2', resumable: true } });
          setTimeout(() => conn.close(1011, 'transient server restart'), 40);
        }
      });
    });

    const client = await connectRawWs({
      port: freePort,
      pathAndQuery: '/admin/voice/ws',
      headers: { Authorization: 'Bearer ' + TOKEN },
    });

    // 1st ready (initial)
    await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'ready' && !f.json.resumed);
    // goAway -> reconnecting -> 2nd ready (resumed: true)
    const reconnecting1 = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'reconnecting' && f.json.reason === 'goAway');
    assert.ok(reconnecting1);
    const resumed1 = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'ready' && f.json.resumed === true);
    assert.ok(resumed1);

    // unexpected 1011 drop -> reconnecting -> 3rd ready (resumed: true)
    const reconnecting2 = await client.waitFor((f) => f.opcode === 1 && f.json?.type === 'reconnecting' && f.json.reason.includes('transient server restart'));
    assert.ok(reconnecting2);
    await client.waitFor(() => client.frames.filter((f) => f.json?.type === 'ready' && f.json.resumed === true).length >= 2);

    assert.deepEqual(receivedHandles, ['', 'handle-alpha-1', 'handle-beta-2']);
    client.close(1000);
    await wait(80);
  });
});
