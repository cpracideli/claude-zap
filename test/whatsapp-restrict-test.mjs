import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const repoRoot = path.resolve(dir, '..');
const tmp = path.join(dir, 'tmp-wa-restrict');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'workspace', 'doc.txt'), 'ola');
fs.writeFileSync(path.join(tmp, 'workspace', 'sample.ogg'), Buffer.from('OggS-fake-opus'));

const sharedCalls = [];
const sharedWaha = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : null;
    sharedCalls.push({ method: req.method, url: req.url, body });
    if (req.url.startsWith('/api/contacts/check-exists')) {
      const ph = new URL(req.url, 'http://x').searchParams.get('phone');
      if (ph === '5519997419074') return res.end(JSON.stringify({ numberExists: true, chatId: '200588025434277@lid' }));
      if (ph === '551997419074') return res.end(JSON.stringify({ numberExists: true, chatId: '551997419074@c.us' }));
      return res.end(JSON.stringify({ numberExists: true, chatId: ph + '@c.us' }));
    }
    const decodedUrl = decodeURIComponent(req.url);
    if (decodedUrl === '/api/SharedSess/lids/200588025434277@lid') {
      return res.end(JSON.stringify({ lid: '200588025434277@lid', pn: '5519997419074@c.us' }));
    }
    if (decodedUrl.startsWith('/api/SharedSess/lids/')) {
      return res.end(JSON.stringify({ lid: '999@lid', pn: '5511994026755@c.us' }));
    }
    res.end(JSON.stringify({ id: 'msg-1' }));
  });
}).listen(4311);

const ownCalls = [];
const ownWaha = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const body = b ? JSON.parse(b) : null;
    ownCalls.push({ method: req.method, url: req.url, body });
    if (req.url.startsWith('/api/contacts/check-exists')) {
      const ph = new URL(req.url, 'http://x').searchParams.get('phone');
      return res.end(JSON.stringify({ numberExists: true, chatId: ph + '@c.us' }));
    }
    res.end(JSON.stringify({ id: 'own-msg-1' }));
  });
}).listen(4312);

const bridge = spawn(process.execPath, [path.join(repoRoot, 'bridge', 'bridge.mjs')], {
  env: {
    ...process.env,
    HOME: tmp,
    PORT: '4313',
    BRIDGE_ADMIN_TOKEN: 'tok-restrict',
    WAHA_URL: 'http://127.0.0.1:4311',
    WAHA_API_KEY: 'shared-secret',
    WAHA_SESSION: 'SharedSess',
    ALLOWED_NUMBERS: '5519997419074',
    WHATSAPP_ALLOW_THIRD_PARTY: 'false',
    STARTUP_NOTICE: 'false',
    AI_MEMORY: 'off',
  },
  stdio: 'ignore',
});

async function waitUp(url) {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('bridge timeout');
}

const post = async (u, body, headers = {}) => {
  const r = await fetch('http://127.0.0.1:4313' + u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
};

const admin = async (method, u, body) => {
  const r = await fetch('http://127.0.0.1:4313/admin' + u, {
    method,
    headers: { Authorization: 'Bearer tok-restrict', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
};

let pass = 0;
const check = (label, cond, detail) => {
  if (!cond) {
    console.error('FAIL:', label, detail === undefined ? '' : detail);
    process.exit(1);
  }
  pass += 1;
  console.log('PASS:', label);
};

try {
  await waitUp('http://127.0.0.1:4313/health');

  const ov = await admin('GET', '/overview');
  check('overview reports sharedNumber=true and allowThirdParty=false', ov.status === 200 && ov.json.whatsapp?.sharedNumber === true && ov.json.whatsapp?.allowThirdParty === false, ov.json.whatsapp);

  // Blocked: third party and group across /send, /send-file, /send-voice, /admin/send, /drafts, and /send command
  const thirdSend = await post('/send', { to: '5511994026755', text: 'oi' });
  check('POST /send blocks third-party number', thirdSend.status === 400 && /bloqueado/i.test(thirdSend.text), thirdSend);

  const groupSend = await post('/send', { to: '1203630000000@g.us', text: 'oi grupo' });
  check('POST /send blocks group', groupSend.status === 400 && /bloqueado/i.test(groupSend.text), groupSend);

  const thirdFile = await post('/send-file', { to: '5511994026755', path: 'doc.txt' });
  check('POST /send-file blocks third-party number', thirdFile.status === 500 && /bloqueado/i.test(thirdFile.text), thirdFile);

  const thirdVoice = await post('/send-voice', { to: '5511994026755', path: 'sample.ogg' });
  check('POST /send-voice blocks third-party number', thirdVoice.status === 400 && /bloqueado/i.test(thirdVoice.text), thirdVoice);

  const adminThird = await admin('POST', '/send', { to: '5511994026755', text: 'oi' });
  check('POST /admin/send blocks third-party number', adminThird.status === 400 && /bloqueado/i.test(adminThird.json.error || ''), adminThird);

  const draftThird = await post('/drafts', { channel: 'whatsapp', to: '5511994026755', body: 'oi' });
  check('POST /drafts blocks whatsapp draft to third-party', draftThird.status === 400 && /bloqueado/i.test(draftThird.text), draftThird);

  const hookRes = await post('/webhook', {
    event: 'message',
    session: 'SharedSess',
    payload: { id: 'm1', from: '5519997419074@c.us', fromMe: false, body: '/send +55 11 99402-6755 oi' },
  });
  check('webhook accepted', hookRes.status === 200, hookRes);
  await new Promise((r) => setTimeout(r, 300));

  const outboundToThird = sharedCalls.filter((c) => ['/api/sendText', '/api/sendFile', '/api/sendImage', '/api/sendVoice'].includes(c.url) && c.body?.chatId !== '5519997419074@c.us');
  check('zero outbound WAHA messages sent to third parties/groups (only /send error reply to owner)', outboundToThird.length === 0, outboundToThird);

  // Allowed: owner's own number (both @lid resolved and BR 9th-digit variant)
  const ownLidSend = await post('/send', { to: '5519997419074', text: 'oi pra mim' });
  check('POST /send allows owner via @lid lookup', ownLidSend.status === 200 && JSON.parse(ownLidSend.text).sent === true, ownLidSend);

  const ownBrSend = await post('/send', { to: '551997419074', text: 'oi variante' });
  check('POST /send allows owner 8-digit BR variant', ownBrSend.status === 200 && JSON.parse(ownBrSend.text).sent === true, ownBrSend);

  const ownFile = await post('/send-file', { to: '5519997419074', path: 'doc.txt' });
  check('POST /send-file allows owner', ownFile.status === 200, ownFile);

  const ownVoice = await post('/send-voice', { to: '5519997419074', path: 'sample.ogg' });
  check('POST /send-voice allows owner', ownVoice.status === 200, ownVoice);

  const ownDraft = await post('/drafts', { channel: 'whatsapp', to: '5519997419074', body: 'lembrete meu' });
  check('POST /drafts allows whatsapp draft to owner', ownDraft.status === 200, ownDraft);

  // Guest access must be rejected on shared number
  const badGuest = await admin('PUT', '/settings', { guestAccess: [{ name: 'Outro', number: '5511999998888', bot: 'default', enabled: true }] });
  check('PUT /admin/settings blocks guestAccess on shared number', badGuest.status === 400 && /compartilhado/i.test(badGuest.json.error || ''), badGuest);

  // Reject pointing own WAHA back to the shared WAHA URL + session
  const sameWaha = await admin('PUT', '/settings', { whatsapp: { ownEnabled: true, url: 'http://127.0.0.1:4311/', session: 'SharedSess', apiKey: 'x' } });
  check('PUT /admin/settings rejects identical shared WAHA URL+session', sameWaha.status === 400, sameWaha);

  // Connect own WAHA -> unlocks third-party sends and switches active WAHA
  const ownSet = await admin('PUT', '/settings', { whatsapp: { ownEnabled: true, url: 'http://127.0.0.1:4312', session: 'OwnSess', apiKey: 'own-key' } });
  check('PUT /admin/settings accepts own WAHA and enables third-party', ownSet.status === 200 && ownSet.json.whatsapp?.allowThirdParty === true && ownSet.json.whatsapp?.sharedNumber === false, ownSet.json.whatsapp);

  const unlockedSend = await post('/send', { to: '5511994026755', text: 'oi pelo meu whatsapp' });
  check('POST /send to third-party succeeds after connecting own WAHA', unlockedSend.status === 200 && ownCalls.some((c) => c.url === '/api/sendText' && c.body?.session === 'OwnSess' && c.body?.chatId === '5511994026755@c.us'), { unlockedSend, ownCalls });

  console.log(`ALL ${pass} WHATSAPP RESTRICTION CHECKS PASSED`);
} finally {
  bridge.kill();
  sharedWaha.close();
  ownWaha.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
