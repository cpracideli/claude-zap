// Local test of bots (personas) and routines (webhook, watch, quiet, run history), with fake Claude and WAHA.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-bots'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
fs.writeFileSync(path.join(tmp, '.claude.json'), JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['pw'] }, gh: { command: 'gh-mcp' } } }));
const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `
import fs from 'node:fs';
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
if (a[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const p = (a.includes('--input-format') ? await new Promise((res) => { let b = ''; process.stdin.on('data', (d) => { b += d; const i = b.indexOf('\\n'); if (i >= 0) { process.stdin.destroy(); try { res(JSON.parse(b.slice(0, i)).message.content.map((x) => x.text || '').join('')); } catch { res(''); } } }); process.stdin.on('end', () => res('')); }) : get('-p')) || '';
const sys = get('--append-system-prompt') || '';
const mcp = get('--mcp-config');
const info = { model: get('--model'), effort: get('--effort'), resume: get('--resume'), hasBots: sys.includes('BOTS:'),
  instr: (sys.match(/INSTR-[A-Z]+/) || [''])[0], mem: (sys.match(/MEM-[A-Z]+/) || [''])[0], strict: a.includes('--strict-mcp-config'),
  mcp: mcp ? Object.keys(JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers) : null, webhookDoc: sys.includes('/hooks/'),
  payload: (p.match(/PAYLOAD-[A-Z0-9]+/) || [''])[0], trig: (p.match(/gatilho: ([^\\]]+)\\]/) || ['', ''])[1] };
const text = p.includes('QUIETPLEASE') ? 'NADA_A_RELATAR' : 'ECHO ' + JSON.stringify(info);
console.log(JSON.stringify({ type: 'result', result: text, session_id: 'sess-' + Date.now(), is_error: false, num_turns: 1, duration_ms: 50, total_cost_usd: 0 }));
`);
const sent = [];
const waha = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  if (req.url === '/api/sendText') sent.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"id":"m1"}'); }); }).listen(4031);
const PORT = 4032, TOKEN = 'tok-bots', W = '5511999990000@c.us';
fs.mkdirSync(path.join(tmp, '.bridge')); fs.writeFileSync(path.join(tmp, '.bridge', 'chats.json'), JSON.stringify({ [W]: { session: 'old-sess', model: 'haiku' } }));
const watchFile = path.join(tmp, 'watched.txt'); fs.writeFileSync(watchFile, 'v1');
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'), BRIDGE_ADMIN_TOKEN: TOKEN,
    ALLOWED_NUMBERS: '5511999990000', WAHA_URL: 'http://127.0.0.1:4031', WAHA_SESSION: 'S', STARTUP_NOTICE: 'false', AI_MEMORY: 'off',
    SCHEDULER_TICK_MS: '300', WATCH_UNIT_MS: '200' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; bridge.stdout.on('data', (d) => { logs += d; }); bridge.stderr.on('data', (d) => { logs += d; });
const base = 'http://127.0.0.1:' + PORT;
const api = async (method, p, body, extra = {}) => {
  const r = await fetch(base + '/admin' + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const local = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const wa = (text) => fetch(base + '/webhook', { method: 'POST', body: JSON.stringify({ event: 'message', session: 'S', payload: { id: 'x' + Math.random(), from: W, body: text } }) });
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } return null; };
const lastWeb = async (id) => (await api('GET', '/web/' + id.slice(4) + '/messages')).body.messages.filter((m) => m.role === 'assistant').at(-1);
const echo = (m) => { try { return JSON.parse(m.text.replace(/^ECHO /, '')); } catch { return {}; } };

try {
  await wait(800);
  // --- compatibility: only the default bot, no extra prompt ---
  let r = await api('GET', '/bots');
  check('default bot exists', r.status === 200 && r.body.length === 1 && r.body[0].id === 'default' && r.body[0].isDefault);
  let c1 = (await api('POST', '/web', {}, { 'X-Panel-Url': 'https://painel.example' })).body;
  check('chat starts on default bot', c1.bot === 'default');
  await api('POST', '/web/' + c1.id.slice(4) + '/messages', { text: 'oi' });
  let m = await until(() => lastWeb(c1.id));
  let e = echo(m);
  check('default bot: no BOTS section in prompt', e.hasBots === false && e.strict === false, e);
  check('panel url learned for webhook docs', e.webhookDoc === true, e);
  check('assistant message carries bot', m.bot === 'default');

  // --- create a bot ---
  r = await api('POST', '/bots', { name: 'Pesquisador Ágil', emoji: '🔎', description: 'pesquisa', instructions: 'INSTR-ALPHA', model: 'sonnet', effort: 'low' });
  check('create bot', r.status === 200 && r.body.id === 'pesquisador-agil' && r.body.memory === 'own', r.body);
  const B = r.body.id;
  check('bad provider rejected', (await api('POST', '/bots', { name: 'x', provider: 'nope' })).status === 400);
  check('bad bot on chat rejected', (await api('PATCH', '/chats/' + encodeURIComponent(c1.id), { bot: 'nope' })).status === 400);
  await api('PUT', '/bots/' + B + '/memory', { content: 'MEM-BRAVO lembrete' });
  check('bot memory read', (await api('GET', '/bots/' + B + '/memory')).body.content.includes('MEM-BRAVO'));

  const c2 = (await api('POST', '/web', { bot: B })).body;
  check('new chat with bot', c2.bot === B);
  await api('POST', '/web/' + c2.id.slice(4) + '/messages', { text: 'pesquise' });
  e = echo(await until(() => lastWeb(c2.id)));
  check('bot instructions, memory, model, effort used', e.instr === 'INSTR-ALPHA' && e.mem === 'MEM-BRAVO' && e.model === 'sonnet' && e.effort === 'low' && e.hasBots, e);

  // chat override beats bot
  await api('PATCH', '/chats/' + encodeURIComponent(c2.id), { model: 'opus' });
  await api('POST', '/web/' + c2.id.slice(4) + '/messages', { text: 'de novo' });
  await wait(600);
  e = echo(await lastWeb(c2.id));
  check('chat model overrides bot model and session resumes', e.model === 'opus' && e.resume && e.resume.startsWith('sess-'), e);

  // switching bot resets the session
  r = await api('PATCH', '/chats/' + encodeURIComponent(c2.id), { bot: 'default' });
  check('switch bot resets session', r.body.bot === 'default' && !r.body.session, r.body);

  // MCP restriction
  await api('PATCH', '/bots/' + B, { mcp: ['pw', 'missing'] });
  await api('PATCH', '/chats/' + encodeURIComponent(c2.id), { bot: B });
  await api('POST', '/web/' + c2.id.slice(4) + '/messages', { text: 'mcp' });
  await wait(600);
  e = echo(await lastWeb(c2.id));
  check('bot limited to chosen MCP servers', e.strict === true && JSON.stringify(e.mcp) === '["pw"]', e);

  // self update by the agent + restore
  const self = await local('PATCH', '/bots/' + B, { instructions: 'INSTR-CHARLIE', model: 'haiku' });
  check('agent can update own instructions but not model', self.instructions === 'INSTR-CHARLIE' && self.model === 'sonnet', self);
  r = await api('GET', '/bots');
  const hist = r.body.find((x) => x.id === B).history;
  check('instruction history kept', hist.length === 1 && hist[0].instructions === 'INSTR-ALPHA' && hist[0].via === 'agent', hist);
  r = await api('POST', '/bots/' + B + '/restore', { at: hist[0].at });
  check('restore instructions', r.body.instructions === 'INSTR-ALPHA' && r.body.history.length === 2);
  check('local /bots list', Array.isArray(await local('GET', '/bots')));

  // --- WhatsApp /bot command ---
  await wa('/bot pesquisador');
  await until(() => sent.some((x) => x.text.includes('Agora quem responde é')));
  let chatsNow = (await api('GET', '/chats')).body;
  let w = chatsNow.find((x) => x.id === W);
  check('/bot switches WhatsApp chat and resets session', w.bot === B && !w.session, w);
  await wa('qual seu modelo');
  const echoed = await until(() => sent.find((x) => x.text.startsWith('ECHO')));
  e = echoed ? JSON.parse(echoed.text.replace(/^ECHO /, '')) : {};
  check('WhatsApp chat override (haiku) still wins over bot model', e.model === 'haiku' && e.instr === 'INSTR-ALPHA', e);
  sent.length = 0;
  await wa('/status');
  await until(() => sent.some((x) => x.text.includes('Bot:')));
  check('/status shows bot', sent.some((x) => x.text.includes('Bot: 🔎 Pesquisador Ágil')), sent.map((x) => x.text));
  sent.length = 0;
  await wa('/bot zzz');
  await until(() => sent.length);
  check('/bot unknown', sent.some((x) => x.text.includes('Bot não encontrado')));

  // --- routines ---
  check('routine needs a trigger', (await api('POST', '/schedules', { chatId: c1.id, prompt: 'x' })).status === 400);
  r = await api('POST', '/schedules', { chatId: c1.id, prompt: 'faça', description: 'hook', webhook: true, bot: B });
  const H = r.body;
  check('webhook routine created with token', r.status === 200 && H.webhook && H.hookToken.length === 32 && H.bot === B, r.body);
  check('webhook bad token 404', (await fetch(base + '/hooks/' + H.id + '/' + 'f'.repeat(32), { method: 'POST', body: '{}' })).status === 404);
  check('webhook GET 405', (await fetch(base + '/hooks/' + H.id + '/' + H.hookToken)).status === 405);
  const hr = await fetch(base + '/hooks/' + H.id + '/' + H.hookToken + '?src=test', { method: 'POST', body: JSON.stringify({ msg: 'PAYLOAD-X1' }) });
  check('webhook accepted', hr.status === 202);
  m = await until(async () => { const x = await lastWeb(c1.id); return x && x.text.includes('PAYLOAD-X1') ? x : null; });
  e = m ? echo({ text: m.text.replace(/^⏰ /, '') }) : {};
  check('webhook run uses routine bot and payload', e.instr === 'INSTR-ALPHA' && e.payload === 'PAYLOAD-X1' && e.trig === 'chamada de webhook', e);
  let runs = (await api('GET', '/schedules/' + H.id + '/runs')).body;
  check('run history recorded', runs.length === 1 && runs[0].status === 'ok' && runs[0].trigger === 'webhook', runs);

  // quiet
  r = await api('POST', '/schedules', { chatId: c1.id, prompt: 'QUIETPLEASE', description: 'quieta', webhook: true, quiet: true });
  const Q = r.body;
  const before = (await api('GET', '/web/' + c1.id.slice(4) + '/messages')).body.messages.length;
  await api('POST', '/schedules/' + Q.id + '/run');
  runs = await until(async () => { const x = (await api('GET', '/schedules/' + Q.id + '/runs')).body; return x[0] && x[0].status !== 'queued' && x[0].status !== 'running' ? x : null; });
  const after = (await api('GET', '/web/' + c1.id.slice(4) + '/messages')).body.messages.length;
  check('quiet routine sends nothing', runs && runs[0].status === 'quiet' && runs[0].trigger === 'manual' && before === after, { runs, before, after });

  // watch
  r = await api('POST', '/schedules', { chatId: c1.id, prompt: 'mudou', description: 'obs', watch: { command: 'cat ' + watchFile, every: 5 } });
  const O = r.body;
  check('watch routine created', r.status === 200 && O.watch.every === 5);
  check('watch every validated', (await api('POST', '/schedules', { chatId: c1.id, prompt: 'x', watch: { command: 'ls', every: 1 } })).status === 400);
  await until(async () => (await api('GET', '/schedules')).body.find((x) => x.id === O.id).watchHash);
  check('first check is baseline only', !((await api('GET', '/schedules/' + O.id + '/runs')).body.length));
  fs.writeFileSync(watchFile, 'v2 PAYLOAD-W2');
  runs = await until(async () => { const x = (await api('GET', '/schedules/' + O.id + '/runs')).body; return x[0] && x[0].status === 'ok' ? x : null; }, 10000);
  check('watch fires on change with output', runs && runs[0].trigger === 'watch' && runs[0].text.includes('PAYLOAD-W2'), runs);

  // patch: switch triggers, list info
  r = await api('PATCH', '/schedules/' + H.id, { webhook: false, cron: '0 8 * * *' });
  check('patch triggers', r.body.cron === '0 8 * * *' && !r.body.webhook && !r.body.hookToken, r.body);
  check('patch rejects no trigger', (await api('PATCH', '/schedules/' + H.id, { cron: '' })).status === 400);
  check('failed patch keeps routine', (await api('GET', '/schedules')).body.find((x) => x.id === H.id).cron === '0 8 * * *');
  const list = (await api('GET', '/schedules')).body;
  check('list shows bot and last run', list.find((x) => x.id === H.id).botName.includes('Pesquisador') && list.find((x) => x.id === O.id).lastRunInfo);
  check('local /schedules still works', Array.isArray(await local('GET', '/schedules?chatId=' + encodeURIComponent(c1.id))));
  r = await local('POST', '/schedules', { chatId: c1.id, prompt: 'p', webhook: true });
  check('agent can create webhook routine', r.hookToken && r.webhook, r);

  // delete bot -> chats and routines fall back to default
  check('default bot cannot be deleted', (await api('DELETE', '/bots/default')).status === 400);
  await api('PATCH', '/schedules/' + H.id, { bot: B });
  await api('DELETE', '/bots/' + B);
  chatsNow = (await api('GET', '/chats')).body;
  check('chats fall back to default bot', chatsNow.every((x) => x.bot === 'default'));
  check('routines lose deleted bot', !(await api('GET', '/schedules')).body.some((x) => x.bot === B));
  check('overview counts bots', (await api('GET', '/overview')).body.bots === 1);
} catch (err) {
  console.log('FAIL exception', err.stack);
  failed++;
}
bridge.kill(); waha.close();
if (failed) console.log(logs.slice(-3000));
console.log(failed ? 'BOTS FAIL (' + failed + ')' : 'BOTS OK');
process.exit(failed ? 1 : 0);
