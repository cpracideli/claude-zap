// Local test of the OpenCode provider (provider "opencode"), driven through WhatsApp (webhook) with a fake `opencode` CLI
// that emits the same JSON event stream as `opencode run --format json`.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-opencode'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
const LOG = path.join(tmp, 'oc-calls.jsonl');
const fakeOc = path.join(tmp, 'opencode.mjs');
fs.writeFileSync(fakeOc, `
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('1.19.6'); process.exit(0); }
if (a[0] === 'models') { console.log('opencode/nemotron-3.5-lightning-free\\nopencode/big-pickle'); process.exit(0); }
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : '';
const prompt = a[a.indexOf('--') + 1] || '';
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ args: a, prompt }) + '\\n');
if (prompt.includes('FAILME')) {
  console.log(JSON.stringify({ type: 'error', sessionID: 'ses_err', error: { name: 'FreeUsageLimitError', data: { message: 'Free usage limit reached' } } }));
  process.exit(0);
}
const sid = get('-s') || 'ses_NEW1234';
console.log(JSON.stringify({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } }));
console.log(JSON.stringify({ type: 'text', sessionID: sid, part: { type: 'text', text: 'ECHO-OC model=' + get('-m') + ' resume=' + get('-s') } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish', cost: 0, tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 5, write: 0 } } } }));
`);
const fakeOcBin = path.join(tmp, 'opencode');
fs.writeFileSync(fakeOcBin, '#!/bin/sh\nexec ' + process.execPath + ' ' + fakeOc + ' "$@"\n', { mode: 0o755 });
const sent = [];
const waha = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  if (req.url === '/api/sendText') sent.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"id":"m1"}'); }); }).listen(4041);
const PORT = 4042, TOKEN = 'tok-oc', W = '5511999990000@c.us';
fs.mkdirSync(path.join(tmp, '.bridge'));
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_BIN: path.join(tmp, 'no-claude'), AGY_BIN: path.join(tmp, 'no-agy'),
    OPENCODE_BIN: fakeOcBin, BRIDGE_ADMIN_TOKEN: TOKEN, ALLOWED_NUMBERS: '5511999990000', WAHA_URL: 'http://127.0.0.1:4041', WAHA_SESSION: 'S',
    STARTUP_NOTICE: 'false', AI_MEMORY: 'off', SCHEDULER_TICK_MS: '300' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; bridge.stdout.on('data', (d) => { logs += d; }); bridge.stderr.on('data', (d) => { logs += d; });
const base = 'http://127.0.0.1:' + PORT;
const api = async (method, p, body) => {
  const r = await fetch(base + '/admin' + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const wa = (text) => fetch(base + '/webhook', { method: 'POST', body: JSON.stringify({ event: 'message', session: 'S', payload: { id: 'x' + Math.random(), from: W, body: text } }) });
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } return null; };
const lastText = () => (sent.length ? sent[sent.length - 1].text : '');
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) failed++; };

try {
  await wait(800);
  // 1) the provider is listed with its live model catalog and is installed
  const info = await api('GET', '/providers');
  const oc = info.body && info.body.providers && info.body.providers.find((p) => p.id === 'opencode');
  check('providers lists opencode as installed', Boolean(oc && oc.installed && oc.version === '1.19.6'), oc);
  check('opencode exposes its models', Boolean(oc && oc.models.length === 2 && oc.defaultModel === 'opencode/nemotron-3.5-lightning-free'), oc);

  // 2) switch this WhatsApp chat to OpenCode
  await wa('/provider opencode');
  const sw = await until(() => sent.find((m) => /Provedor desta conversa: OpenCode/.test(m.text)));
  check('/provider opencode confirms the switch', Boolean(sw), sent.map((m) => m.text));

  // 3) first message: default free model, bridge instructions in the prompt, no resume
  await wa('oi, primeira');
  const c1 = await until(async () => (calls().length >= 1 && sent.find((m) => /ECHO-OC/.test(m.text))) || null);
  const k1 = calls()[0];
  check('first turn runs opencode run with json + default model', Boolean(k1 && k1.args[0] === 'run' && k1.args.includes('--format') && k1.args.includes('json') && k1.args[k1.args.indexOf('-m') + 1] === 'opencode/nemotron-3.5-lightning-free'), k1);
  check('first turn sends the bridge instructions before the message', Boolean(k1 && k1.prompt.includes('oi, primeira') && k1.prompt.includes('\n\n---\n\n')), k1 && k1.prompt.slice(0, 200));
  check('reply text reaches WhatsApp', Boolean(c1), sent.map((m) => m.text));
  check('no -s on the first turn', Boolean(k1 && !k1.args.includes('-s')), k1);

  // 4) second message resumes the stored OpenCode session
  await wa('segunda');
  await until(() => calls().length >= 2 && sent.filter((m) => /ECHO-OC/.test(m.text)).length >= 2);
  const k2 = calls()[1];
  check('second turn resumes session ses_NEW1234 (-s)', Boolean(k2 && k2.args[k2.args.indexOf('-s') + 1] === 'ses_NEW1234'), k2);
  check('second turn has no bridge instructions again', Boolean(k2 && k2.prompt === 'segunda'), k2 && k2.prompt);

  // 5) /model with a catalog id changes the model for this chat; an unknown id is refused
  await wa('/model opencode/big-pickle');
  await until(() => sent.find((m) => /Modelo OpenCode desta conversa: opencode\/big-pickle/.test(m.text)));
  await wa('terceira');
  await until(() => calls().length >= 3);
  const k3 = calls()[2];
  check('/model changes the OpenCode model used', Boolean(k3 && k3.args[k3.args.indexOf('-m') + 1] === 'opencode/big-pickle'), k3);
  await wa('/model opencode/inexistente');
  const bad = await until(() => sent.find((m) => /Modelo não encontrado/.test(m.text)));
  check('/model refuses an id outside the catalog', Boolean(bad), sent.map((m) => m.text).slice(-2));

  // 6) /new clears the OpenCode session, so the next turn starts fresh
  await wa('/new');
  await until(() => sent.find((m) => /Nova conversa iniciada/.test(m.text)));
  await wa('quarta');
  await until(() => calls().length >= 4);
  const k4 = calls()[3];
  check('/new drops the OpenCode session', Boolean(k4 && !k4.args.includes('-s')), k4);

  // 7) an error from OpenCode (e.g. free limit) is reported, not swallowed
  await wa('FAILME por favor');
  const err = await until(() => sent.find((m) => /Erro ao executar OpenCode/.test(m.text)));
  check('OpenCode error is reported to the user', Boolean(err), sent.map((m) => m.text).slice(-1));

  // 8) usage is logged under the opencode provider
  const usage = await api('GET', '/usage');
  check('usage endpoint responds', usage.status === 200, usage.status);
  check('usage log file records opencode runs', fs.existsSync(path.join(tmp, '.bridge', 'usage.jsonl')) ? fs.readFileSync(path.join(tmp, '.bridge', 'usage.jsonl'), 'utf8').includes('"provider":"opencode"') : false);
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  bridge.kill('SIGTERM'); waha.close();
  console.log(failed ? failed + ' FAILED' : 'ALL OK');
  if (failed) console.log(logs.slice(-3000));
  process.exit(failed ? 1 : 0);
}
