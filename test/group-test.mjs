// Local test of mid-run messages (steering), @mentions / groups and bot-to-bot delegation, with fake Claude and WAHA.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-group'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
const PORT = 4042, TOKEN = 'tok-group', W = '5511999990000@c.us';
const fakeClaude = path.join(tmp, 'claude.mjs');
// Reads user messages from stdin (stream-json). "SLOW" waits 1.5 s and reports the extra messages it got meanwhile.
// "DELEGATE:<bot> rest" asks that bot through the bridge (like the real agent would with curl) with "rest" as question.
fs.writeFileSync(fakeClaude, `
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
if (a[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const msgs = []; let buf = ''; let wake = null;
if (a.includes('--input-format')) {
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    try { msgs.push(JSON.parse(l).message.content.map((x) => x.text || '').join('')); } catch {} if (wake) wake(); } });
  process.stdin.on('error', () => {});
} else {
  msgs.push(get('-p') || '');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (!msgs.length) await new Promise((r) => { wake = r; setTimeout(r, 50); });
const p = msgs[0];
const sys = get('--append-system-prompt') || '';
const me = (sys.match(/você é o bot "([^"]+)"/) || [, 'Claude'])[1];
if (p.includes('SLOW')) await sleep(1500);
let deleg = '';
const m = p.match(/DELEGATE:(\\S+)\\s*([\\s\\S]*)/);
if (m) {
  const r = await fetch('http://127.0.0.1:${PORT}/bots/' + m[1] + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.WA_CHAT_ID, question: m[2] || 'ajuda', wait: 20 }) });
  const j = await r.json();
  deleg = ' DELEG=' + (j.answer || j.error);
}
const ctx = p.includes('Contexto recente') ? ' ctx=' + (p.match(/^(Claude|Tradutor|Pesquisador): R\\[/m) ? 'saw-' + p.match(/^(Claude|Tradutor|Pesquisador): R\\[/m)[1] : 'none') : '';
const modTag = (get('--model') ? ' mod=' + get('--model') : '') + (get('--effort') ? ' eff=' + get('--effort') : '');
const text = 'R[' + me + '] ' + p.split('\\n').slice(-1)[0].slice(0, 60) + modTag + (msgs.length > 1 ? ' injected=' + msgs.slice(1).map((x) => x.split('\\n').slice(-1)[0]).join('|') : '') + ctx + deleg;
console.log(JSON.stringify({ type: 'result', result: text, session_id: 'sess-' + me, is_error: false, num_turns: 1, duration_ms: 10, total_cost_usd: 0 }));
process.exit(0);
`);
const sent = [];
const waha = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  if (req.url === '/api/sendText') sent.push(JSON.parse(b).text); res.setHeader('Content-Type', 'application/json'); res.end('{"id":"m1"}'); }); }).listen(4041);
fs.mkdirSync(path.join(tmp, '.bridge')); fs.writeFileSync(path.join(tmp, '.bridge', 'chats.json'), JSON.stringify({ [W]: {} }));
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'), BRIDGE_ADMIN_TOKEN: TOKEN,
    ALLOWED_NUMBERS: '5511999990000', WAHA_URL: 'http://127.0.0.1:4041', WAHA_SESSION: 'S', STARTUP_NOTICE: 'false', AI_MEMORY: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; bridge.stdout.on('data', (d) => { logs += d; }); bridge.stderr.on('data', (d) => { logs += d; });
const base = 'http://127.0.0.1:' + PORT;
const api = async (method, p, body) => {
  const r = await fetch(base + '/admin' + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const wa = (text) => fetch(base + '/webhook', { method: 'POST', body: JSON.stringify({ event: 'message', session: 'S', payload: { id: 'x' + Math.random(), from: W, body: text } }) });
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } return null; };
const msgs = async (id) => (await api('GET', '/web/' + id.slice(4) + '/messages')).body.messages;
const newChat = async (b) => (await api('POST', '/web', b || {})).body;
const say = (id, text) => api('POST', '/web/' + id.slice(4) + '/messages', { text });
const replies = async (id, n) => until(async () => { const x = (await msgs(id)).filter((m) => m.role === 'assistant'); return x.length >= n ? x : null; });

try {
  await wait(800);
  // --- steering, web ---
  let c = await newChat();
  await say(c.id, 'SLOW primeira');
  await wait(400);
  let r = await say(c.id, 'segunda');
  check('web: message during run is injected', r.body.injected === true && r.body.queued === false, r.body);
  let rep = await replies(c.id, 1);
  check('web: answer took the injected message', rep && rep[0].text.includes('injected=segunda'), rep);
  check('web: one answer only', (await msgs(c.id)).filter((m) => m.role === 'assistant').length === 1);
  check('web: user message flagged injected', (await msgs(c.id)).find((m) => m.text === 'segunda').injected === true);
  r = await say(c.id, 'depois');
  check('web: idle chat runs normally', r.body.injected === false);
  await replies(c.id, 2);

  // --- steering, WhatsApp ---
  await wa('SLOW zap');
  await wait(400);
  await wa('mais uma');
  const ans = await until(() => sent.find((x) => x.startsWith('R[')));
  check('whatsapp: ack for injected message', sent.some((x) => x.includes('📨 Recebi')), sent);
  check('whatsapp: answer took the injected message', ans && ans.includes('injected=mais uma'), sent);

  // --- bots for groups ---
  await api('POST', '/bots', { name: 'Tradutor', emoji: '✍️', description: 'traduz textos' });
  await api('POST', '/bots', { name: 'Pesquisador', emoji: '🔎', description: 'pesquisa' });

  // --- @mention ---
  c = await newChat();
  await say(c.id, '@tradutor traduza isto');
  rep = await replies(c.id, 1);
  check('@mention: mentioned bot answers', rep && rep[0].bot === 'tradutor' && rep[0].text.startsWith('R[Tradutor]'), rep);
  await say(c.id, 'normal');
  rep = await replies(c.id, 2);
  check('no mention: chat bot answers', rep && rep[1].bot === 'default' && rep[1].text.startsWith('R[Claude]'), rep);
  check('chat bot unchanged', (await api('GET', '/chats')).body.find((x) => x.id === c.id).bot === 'default');

  // --- @todos, with context of earlier answers ---
  await say(c.id, '@todos opinem');
  rep = await replies(c.id, 5);
  const last3 = rep && rep.slice(-3);
  check('@todos: every bot answers in order', last3 && last3.map((m) => m.bot).join(',') === 'default,tradutor,pesquisador', last3 && last3.map((m) => m.bot));
  check('@todos: later bots see earlier answers', last3 && last3[2].text.includes('ctx=saw-'), last3);

  // --- members restrict @todos ---
  await api('PATCH', '/chats/' + encodeURIComponent(c.id), { members: ['tradutor', 'pesquisador'] });
  await say(c.id, '@todos de novo');
  rep = await replies(c.id, 7);
  check('@todos uses chat members', rep && rep.slice(-2).map((m) => m.bot).join(',') === 'tradutor,pesquisador', rep && rep.map((m) => m.bot));
  check('chat view shows members', (await api('GET', '/chats')).body.find((x) => x.id === c.id).members.length === 2);

  // --- WhatsApp @mention ---
  sent.length = 0;
  await wa('@pesquisador ache algo');
  const wm = await until(() => sent.find((x) => x.includes('R[Pesquisador]')));
  check('whatsapp @mention prefixes bot name', wm && wm.startsWith('*🔎 Pesquisador:*'), sent);

  // --- delegation ---
  c = await newChat();
  await say(c.id, 'DELEGATE:tradutor traduza hello');
  rep = await replies(c.id, 1);
  check('delegation: answer comes back to caller', rep && rep[0].text.includes('DELEG=R[Tradutor]'), rep);
  check('delegation: card stored on reply', rep && rep[0].delegations && rep[0].delegations[0].bot === 'tradutor' && rep[0].delegations[0].status === 'done' && rep[0].delegations[0].answer.includes('R[Tradutor]'), rep && rep[0]);
  check('delegation chats hidden from list', !(await api('GET', '/chats')).body.some((x) => x.id.startsWith('deleg:')));
  check('delegation chats listed with all=1', (await api('GET', '/chats?all=1')).body.some((x) => x.kind === 'delegation'));
  const dc = (await api('GET', '/chats?all=1')).body.find((x) => x.kind === 'delegation');
  check('cannot schedule into a delegation chat', (await api('POST', '/schedules', { chatId: dc.id, prompt: 'x', cron: '0 8 * * *' })).status === 400);

  // self-delegation refused
  const c2 = await newChat({ bot: 'tradutor' });
  await say(c2.id, 'DELEGATE:tradutor x');
  rep = await replies(c2.id, 1);
  check('a bot cannot delegate to itself', rep && rep[0].text.includes('para si mesmo'), rep);

  // depth limit: default -> tradutor -> pesquisador -> (claude refused)
  const c3 = await newChat();
  await say(c3.id, 'DELEGATE:tradutor DELEGATE:pesquisador DELEGATE:claude fim');
  rep = await replies(c3.id, 1, 15000);
  check('chain of two delegations works, third refused', rep && rep[0].text.includes('R[Tradutor]') && rep[0].text.includes('R[Pesquisador]') && rep[0].text.includes('limite de delegação'), rep && rep[0].text);

  // long poll endpoint
  const pr = await fetch(base + '/bots/pesquisador/ask', { method: 'POST', body: JSON.stringify({ from: c.id, question: 'SLOW lento', wait: 0 }) }).then((x) => x.json());
  check('ask with wait 0 returns running', pr.status === 'running' && pr.id, pr);
  const done = await fetch(base + '/asks/' + pr.id + '?wait=10').then((x) => x.json());
  check('long poll returns the answer', done.status === 'done' && done.answer.includes('R[Pesquisador]'), done);
  check('ask needs a known from', (await fetch(base + '/bots/pesquisador/ask', { method: 'POST', body: JSON.stringify({ from: 'x', question: 'q' }) })).status === 400);

  // --- inheritance on @mention and delegation ---
  await api('PATCH', '/bots/default', { model: 'opus', effort: 'high' });
  await api('PATCH', '/bots/pesquisador', { model: 'haiku' }); // explicit own model
  // tradutor has no own model -> inherits chat override or default bot
  const cInh = await newChat();
  await say(cInh.id, '@tradutor herdar do default');
  rep = await replies(cInh.id, 1);
  check('@mention inherited bot falls back to default bot config', rep && rep[0].text.includes('mod=opus') && rep[0].text.includes('eff=high'), rep);
  await api('PATCH', '/chats/' + encodeURIComponent(cInh.id), { model: 'sonnet', effort: 'low' });
  await say(cInh.id, '@tradutor herdar do chat');
  rep = await replies(cInh.id, 2);
  check('@mention inherited bot uses chat override', rep && rep[1].text.includes('mod=sonnet') && rep[1].text.includes('eff=low'), rep);
  // delegation to inherited bot copies chat/caller override; delegation to bot with own model respects own model
  const dInh = await fetch(base + '/bots/tradutor/ask', { method: 'POST', body: JSON.stringify({ from: cInh.id, question: 'deleg herdada', wait: 10 }) }).then((x) => x.json());
  check('delegation to inherited bot inherits chat config', dInh.status === 'done' && dInh.answer.includes('mod=sonnet') && dInh.answer.includes('eff=low'), dInh);
  const dOwn = await fetch(base + '/bots/pesquisador/ask', { method: 'POST', body: JSON.stringify({ from: cInh.id, question: 'deleg proprio', wait: 10 }) }).then((x) => x.json());
  check('delegation to bot with own model respects target model', dOwn.status === 'done' && dOwn.answer.includes('mod=haiku') && dOwn.answer.includes('eff=low'), dOwn);
} catch (err) {
  console.log('FAIL exception', err.stack);
  failed++;
}
bridge.kill(); waha.close();
if (failed) console.log(logs.slice(-3000));
console.log(failed ? 'GROUP FAIL (' + failed + ')' : 'GROUP OK');
process.exit(failed ? 1 : 0);
