// AI chat title: generated after first exchange with the cheap model, never over manual titles, safe on failure.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-title'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `
import fs from 'node:fs';
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
if (a[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const p = (a.includes('--input-format') ? await new Promise((res) => { let b = ''; process.stdin.on('data', (d) => { b += d; const i = b.indexOf('\\n'); if (i >= 0) { process.stdin.destroy(); try { res(JSON.parse(b.slice(0, i)).message.content.map((x) => x.text || '').join('')); } catch { res(''); } } }); process.stdin.on('end', () => res('')); }) : get('-p')) || '';
const isTitle = p.includes('Gere um título curto');
if (isTitle) fs.appendFileSync(${JSON.stringify(path.join(tmp, 'title-calls.log'))}, (get('--model') || '') + '\\n');
const text = isTitle ? (p.includes('FALHAR') ? '' : 'Título: "Planejar viagem a Paris".\\nextra') : 'resposta normal';
console.log(JSON.stringify({ type: 'result', result: text, session_id: 's' + Date.now(), is_error: false, num_turns: 1, duration_ms: 20, total_cost_usd: 0 }));
`);
const PORT = 4042, TOKEN = 'tok-title';
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'), BRIDGE_ADMIN_TOKEN: TOKEN, STARTUP_NOTICE: 'false', AI_MEMORY: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; bridge.stdout.on('data', (d) => { logs += d; }); bridge.stderr.on('data', (d) => { logs += d; });
const api = async (method, p, body) => { const r = await fetch('http://127.0.0.1:' + PORT + '/admin' + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
let failed = 0;
const check = (n, ok, x) => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + JSON.stringify(x))); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } return null; };
const title = async (id) => (await api('GET', '/chats?all=1')).body.find((c) => c.id === id).title;
try {
  await wait(800);
  const c1 = (await api('POST', '/web', {})).body;
  await api('POST', '/web/' + c1.id.slice(4) + '/messages', { text: 'quero ajuda para planejar uma viagem' });
  check('title generated', await until(async () => (await title(c1.id)) === 'Planejar viagem a Paris'), await title(c1.id));
  check('cheap model used', fs.readFileSync(path.join(tmp, 'title-calls.log'), 'utf8').trim() === 'haiku');
  check('no leftover scratch chat', !(await api('GET', '/chats?all=1')).body.some((c) => c.id.startsWith('title:')));
  // not regenerated on second message
  await api('POST', '/web/' + c1.id.slice(4) + '/messages', { text: 'e hotéis?' });
  await wait(1500);
  check('not regenerated', fs.readFileSync(path.join(tmp, 'title-calls.log'), 'utf8').trim().split('\n').length === 1);
  // manual title kept
  const c2 = (await api('POST', '/web', {})).body;
  await api('PATCH', '/chats/' + c2.id, { title: 'Meu título' });
  await api('POST', '/web/' + c2.id.slice(4) + '/messages', { text: 'oi' });
  await wait(2000);
  check('manual title preserved', (await title(c2.id)) === 'Meu título');
  // failure keeps current title
  const c3 = (await api('POST', '/web', {})).body;
  await api('POST', '/web/' + c3.id.slice(4) + '/messages', { text: 'FALHAR isto' });
  await wait(2500);
  check('failure keeps title', (await title(c3.id)) === 'FALHAR isto');
} catch (e) { console.log('FAIL exception', e.stack); failed++; }
bridge.kill();
if (failed) console.log(logs.slice(-2500));
console.log(failed ? 'TITLE FAIL (' + failed + ')' : 'TITLE OK');
process.exit(failed ? 1 : 0);
