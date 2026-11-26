// /send-file with a web chatId: the file is copied to INBOX, posted as an assistant message with files, and served for download.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-webfile'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
const PORT = 3997, TOKEN = 'tok-wf';
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, '.config'), CLAUDE_BIN: path.join(tmp, 'no-claude'), AGY_BIN: path.join(tmp, 'no-agy'),
    COPILOT_BIN: path.join(tmp, 'no-copilot'), OPENCODE_BIN: path.join(tmp, 'no-opencode'), BRIDGE_ADMIN_TOKEN: TOKEN, WORKDIR: path.join(tmp, 'ws'),
    ALLOWED_NUMBERS: '5511999990000', WAHA_URL: 'http://127.0.0.1:1', STARTUP_NOTICE: 'false', BRIDGE_AUTO_TITLE: 'off', AI_MEMORY: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; bridge.stdout.on('data', (d) => { logs += d; }); bridge.stderr.on('data', (d) => { logs += d; });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) failed++; };
const api = async (method, p, body) => {
  const r = await fetch('http://127.0.0.1:' + PORT + '/admin' + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
try {
  for (let i = 0; i < 50; i++) { try { await fetch('http://127.0.0.1:' + PORT + '/health'); break; } catch { await wait(100); } }
  const created = await api('POST', '/web', {});
  const id = created.body.id; const short = id.slice(4);
  const src = path.join(tmp, 'relatório final.pdf'); fs.writeFileSync(src, '%PDF-1.4 hello');
  const r = await fetch('http://127.0.0.1:' + PORT + '/send-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: id, path: src, caption: 'Segue o relatório' }) });
  check('send-file web returns 200', r.status === 200, { status: r.status, text: await r.text() });
  const h = await api('GET', '/web/' + short + '/messages');
  const msgs = Array.isArray(h.body) ? h.body : h.body.messages;
  const m = msgs.at(-1);
  check('assistant message with file', m && m.role === 'assistant' && m.text === 'Segue o relatório' && m.files?.[0]?.type === 'application/pdf' && m.files[0].name === 'relatório final.pdf' && m.files[0].size === 14, m);
  const f = await fetch('http://127.0.0.1:' + PORT + '/admin/web/files/' + encodeURIComponent(m.files[0].file) + '?download=1', { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('file served with attachment disposition', f.status === 200 && /attachment/.test(f.headers.get('content-disposition') || '') && (await f.text()) === '%PDF-1.4 hello', { status: f.status, cd: f.headers.get('content-disposition') });
  const svg = path.join(tmp, 'x.svg'); fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await fetch('http://127.0.0.1:' + PORT + '/send-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: id, path: svg }) });
  const h2 = await api('GET', '/web/' + short + '/messages');
  const sm = (Array.isArray(h2.body) ? h2.body : h2.body.messages).at(-1);
  const sf = await fetch('http://127.0.0.1:' + PORT + '/admin/web/files/' + encodeURIComponent(sm.files[0].file), { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('svg served as text/plain (no script execution)', /^text\/plain/.test(sf.headers.get('content-type') || ''), sf.headers.get('content-type'));
  const bad = await fetch('http://127.0.0.1:' + PORT + '/send-file', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId: id, path: path.join(tmp, 'nope.txt') }) });
  check('missing file errors', bad.status === 500, bad.status);
} catch (e) { console.error(e); failed++; }
bridge.kill();
if (failed) { console.log(logs.slice(-2000)); process.exit(1); }
console.log('WEB SEND-FILE OK');
