import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const repoRoot = path.resolve(dir, '..');
const panelRoot = path.resolve(repoRoot, '..', 'agent-control-panel');

let pass = 0;
function check(label, cond, detail) {
  if (!cond) {
    console.error('FAIL:', label, detail === undefined ? '' : detail);
    process.exit(1);
  }
  pass += 1;
  console.log('PASS:', label);
}

// 1. Zero personal/infra hardcoded strings in repository files
const FORBIDDEN_RE = /\bcaio\b|137\.131\.175\.211|xwdcjbwbo2sqvjhfpxzdwsuf|cpracideli@gmail\.com|b80f57|c772db|41f73f/i;
const bridgeFiles = [
  path.join(repoRoot, 'bridge', 'bridge.mjs'),
  path.join(repoRoot, 'build-compose.mjs'),
  path.join(repoRoot, '.env.example'),
  path.join(repoRoot, 'docker-compose.yml'),
  path.join(repoRoot, 'docker-compose.stack.yml'),
];
for (const f of bridgeFiles) {
  const txt = fs.readFileSync(f, 'utf8');
  const m = FORBIDDEN_RE.exec(txt);
  check(`no personal/infra hardcodes in ${path.basename(f)}`, !m, m ? m[0] : '');
}

const bridgeSrc = fs.readFileSync(path.join(repoRoot, 'bridge', 'bridge.mjs'), 'utf8');
check('zero "$" characters in bridge/bridge.mjs', !bridgeSrc.includes('$'));

if (fs.existsSync(panelRoot)) {
  for (const rel of ['server.js', 'src/pages/Status.jsx', 'src/pages/Computer.jsx', '.env.example']) {
    const txt = fs.readFileSync(path.join(panelRoot, rel), 'utf8');
    const m = FORBIDDEN_RE.exec(txt);
    check(`no personal/infra hardcodes in agent-control-panel/${rel}`, !m, m ? m[0] : '');
  }
} else {
  console.log('SKIP: sibling agent-control-panel repo not present');
}

// 2. Compose structure checks
const composeSingle = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
const composeStack = fs.readFileSync(path.join(repoRoot, 'docker-compose.stack.yml'), 'utf8');
check('docker-compose.yml keeps single claude-bridge service', composeSingle.includes('claude-bridge:') && !composeSingle.includes('agent-control:'));
check('docker-compose.yml includes Live Computer + voice packages (novnc, xvfb, ffmpeg, espeak-ng)', ['novnc', 'xvfb', 'x11vnc', 'websockify', 'fluxbox', 'ffmpeg', 'espeak-ng'].every((p) => composeSingle.includes(p)));
check('docker-compose.stack.yml includes both claude-bridge and agent-control', composeStack.includes('claude-bridge:') && composeStack.includes('agent-control:'));
const singleBridgeLine = composeSingle.split('\n').find((l) => l.includes('const OWNER_NAME'));
const stackBridgeLine = composeStack.split('\n').find((l) => l.includes('const OWNER_NAME'));
check('both composes embed the updated bridge.mjs', Boolean(singleBridgeLine && stackBridgeLine));

// 3. Bridge starts in web-only mode (no WAHA_URL / ALLOWED_NUMBERS), exposes disk in /health, and honors OWNER_NAME
async function waitUp(url, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('timeout waiting for ' + url);
}

const tmpWebOnly = path.join(dir, 'tmp-portability-web');
fs.rmSync(tmpWebOnly, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpWebOnly, 'workspace'), { recursive: true });
const bridgeNoWaha = spawn(process.execPath, [path.join(repoRoot, 'bridge', 'bridge.mjs')], {
  env: { ...process.env, HOME: tmpWebOnly, PORT: '4291', BRIDGE_ADMIN_TOKEN: 'tok-web', WAHA_URL: '', ALLOWED_NUMBERS: '', OWNER_NAME: '', AI_MEMORY: 'off', STARTUP_NOTICE: 'true' },
  stdio: 'ignore',
});
try {
  const h = await waitUp('http://127.0.0.1:4291/health');
  check('web-only /health returns ok:true and disk object', h.ok === true && h.disk && typeof h.disk.usedPct === 'number' && typeof h.disk.freeGb === 'number', h);

  const chatRes = await fetch('http://127.0.0.1:4291/admin/web', {
    method: 'POST', headers: { Authorization: 'Bearer tok-web', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Teste' }),
  });
  const ch = await chatRes.json();
  const mbRes = await fetch('http://127.0.0.1:4291/admin/workflows/preset/morning-briefing', {
    method: 'POST', headers: { Authorization: 'Bearer tok-web', 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: ch.id, withAudio: true }),
  });
  const mb = await mbRes.json();
  check('morning-briefing without OWNER_NAME omits Caio and mentions /send-voice', mb.schedule && !/\bcaio\b/i.test(mb.schedule.prompt) && mb.schedule.prompt.includes('/send-voice'), mb.schedule?.prompt);
} finally {
  bridgeNoWaha.kill();
}

const tmpOwner = path.join(dir, 'tmp-portability-owner');
fs.rmSync(tmpOwner, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpOwner, 'workspace'), { recursive: true });
const bridgeOwner = spawn(process.execPath, [path.join(repoRoot, 'bridge', 'bridge.mjs')], {
  env: { ...process.env, HOME: tmpOwner, PORT: '4292', BRIDGE_ADMIN_TOKEN: 'tok-owner', WAHA_URL: '', ALLOWED_NUMBERS: '', OWNER_NAME: 'Maria', AI_MEMORY: 'off' },
  stdio: 'ignore',
});
try {
  await waitUp('http://127.0.0.1:4292/health');
  const ch = await (await fetch('http://127.0.0.1:4292/admin/web', {
    method: 'POST', headers: { Authorization: 'Bearer tok-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Teste Owner' }),
  })).json();
  const mb = await (await fetch('http://127.0.0.1:4292/admin/workflows/preset/morning-briefing', {
    method: 'POST', headers: { Authorization: 'Bearer tok-owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: ch.id, withAudio: false }),
  })).json();
  check('morning-briefing with OWNER_NAME=Maria personalizes prompt', mb.schedule && mb.schedule.prompt.includes('de Maria'), mb.schedule?.prompt);
} finally {
  bridgeOwner.kill();
}

// 4. POST /send-voice sends /api/sendVoice with audio/ogg; codecs=opus to fake WAHA
const tmpVoice = path.join(dir, 'tmp-portability-voice');
fs.rmSync(tmpVoice, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpVoice, 'workspace'), { recursive: true });
fs.writeFileSync(path.join(tmpVoice, 'workspace', 'sample.ogg'), Buffer.from('OggS-fake-opus'));
const voiceCalls = [];
const fakeWaha = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
    voiceCalls.push({ method: req.method, url: req.url, body: b ? JSON.parse(b) : null });
    if (req.url.startsWith('/api/contacts/check-exists')) {
      return res.end(JSON.stringify({ numberExists: true, chatId: '5511999990001@c.us' }));
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'voice-msg-1' }));
  });
}).listen(4293);

const bridgeVoice = spawn(process.execPath, [path.join(repoRoot, 'bridge', 'bridge.mjs')], {
  env: { ...process.env, HOME: tmpVoice, PORT: '4294', WAHA_URL: 'http://127.0.0.1:4293', WAHA_API_KEY: 'k', WAHA_SESSION: 'S', ALLOWED_NUMBERS: '5511999990001', AI_MEMORY: 'off', STARTUP_NOTICE: 'false' },
  stdio: 'ignore',
});
try {
  await waitUp('http://127.0.0.1:4294/health');
  const vr = await fetch('http://127.0.0.1:4294/send-voice', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: '5511999990001', path: 'sample.ogg' }),
  });
  const vj = await vr.json();
  const svCall = voiceCalls.find((c) => c.url === '/api/sendVoice');
  check('POST /send-voice calls WAHA /api/sendVoice with audio/ogg; codecs=opus', vr.status === 200 && vj.sent === true && svCall && svCall.body?.file?.mimetype === 'audio/ogg; codecs=opus', { status: vr.status, vj, svCall });
} finally {
  bridgeVoice.kill();
  fakeWaha.close();
}

// 5. agent-control-panel server.js without Coolify envs returns coolify:false and HTTP 503
if (fs.existsSync(panelRoot)) {
  const cleanEnv = { ...process.env, PORT: '4295', ADMIN_PASSWORD: 'test-pass-123', BRIDGE_URL: 'http://127.0.0.1:4299', BRIDGE_ADMIN_TOKEN: 'tok', COOLIFY_URL: '', COOLIFY_TOKEN: '', COOLIFY_APP_UUID: '', GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '', ALLOWED_AUTH_EMAILS: '' };
  const panelProc = spawn(process.execPath, [path.join(panelRoot, 'server.js')], { cwd: panelRoot, env: cleanEnv, stdio: 'ignore' });
  try {
    const me = await waitUp('http://127.0.0.1:4295/api/me');
    check('panel /api/me reports coolify:false when Coolify envs unset', me.coolify === false && me.password === true, me);

    const loginRes = await fetch('http://127.0.0.1:4295/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass-123' }),
    });
    const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie.includes('acp_session='), 'expected session cookie');
    const cRes = await fetch('http://127.0.0.1:4295/api/coolify/status', { headers: { Cookie: cookie } });
    const cBody = await cRes.json();
    check('panel /api/coolify/status returns 503 when Coolify is unconfigured', cRes.status === 503 && /não configurad/i.test(cBody.error || ''), { status: cRes.status, cBody });
  } finally {
    panelProc.kill();
  }
}

fs.rmSync(tmpWebOnly, { recursive: true, force: true });
fs.rmSync(tmpOwner, { recursive: true, force: true });
fs.rmSync(tmpVoice, { recursive: true, force: true });
console.log(`ALL ${pass} PORTABILITY CHECKS PASSED`);
