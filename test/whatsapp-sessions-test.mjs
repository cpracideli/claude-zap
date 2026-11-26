// Linked sessions: every WhatsApp session is mirrored into a web chat (channel/origin/live), /new freezes it with its
// Claude Code session id, /session lists (America/Sao_Paulo) and /session N resumes, and the panel can continue both
// the live session (same session id as WhatsApp) and archived ones. Fake claude logs every call with --resume.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-wasessions'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
fs.mkdirSync(path.join(tmp, '.bridge'));
const LOG = path.join(tmp, 'calls.jsonl');
const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `
import fs from 'node:fs';
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
if (a[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const p = get('-p') || '';
if (p.includes('Gere um título curto')) {
  const m = /Mensagem do usuário:\\n(\\S+)/.exec(p);
  console.log(JSON.stringify({ type: 'result', result: 'Assunto ' + (m ? m[1] : 'x'), session_id: 'title', is_error: false, num_turns: 1, duration_ms: 5 }));
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ resume: get('--resume'), prompt: p }) + '\\n');
const last = p.split('\\n').filter(Boolean).pop() || '';
if (last.includes('LENTO')) await new Promise((r) => setTimeout(r, 2500));
const sid = get('--resume') || ('sess-' + Math.random().toString(36).slice(2, 8));
console.log(JSON.stringify({ type: 'result', result: 'CLAUDE respondeu a: ' + last, session_id: sid, is_error: false, num_turns: 1, duration_ms: 10 }));
`);

const sent = [];
const waha = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  if (req.url === '/api/sendText') sent.push(JSON.parse(b));
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/sendPoll') { res.statusCode = 500; return res.end('{}'); } // force numbered menus
  res.end('{"id":"m1"}'); }); }).listen(4071);
const PORT = 4072, TOKEN = 'tok-wasess', W = '5511999990000@c.us';
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'), OPENCODE_BIN: path.join(tmp, 'no-oc'),
    BRIDGE_ADMIN_TOKEN: TOKEN, ALLOWED_NUMBERS: '5511999990000', WAHA_URL: 'http://127.0.0.1:4071', WAHA_SESSION: 'S', TZ: 'America/Sao_Paulo',
    STARTUP_NOTICE: 'false', AI_MEMORY: 'off', CLAUDE_STEERING: 'off', CLAUDE_EFFORT: '' },
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
async function turn(text) {
  const before = calls().length, n = sent.length;
  await wa(text);
  await until(() => sent.slice(n).some((m) => /respondeu a:|Erro ao executar/.test(m.text)));
  await wait(200);
  return calls().slice(before);
}
async function cmd(text, re) { const n = sent.length; await wa(text); return until(() => sent.slice(n).find((m) => re.test(m.text))); }
const chatsList = async () => (await api('GET', '/chats?all=1')).body;
const view = async (id) => (await chatsList()).find((c) => c.id === id);
const mirrors = async () => (await chatsList()).filter((c) => c.origin === W);
const msgs = async (id) => (await api('GET', '/web/' + id.slice(4) + '/messages?read=0')).body.messages;
async function panel(id, text) {
  const before = calls().length;
  const n = (await msgs(id)).length;
  await api('POST', '/web/' + id.slice(4) + '/messages', { text });
  await until(async () => (await msgs(id)).slice(n).some((m) => m.role === 'assistant'));
  await wait(200);
  return calls().slice(before);
}
const spDate = (iso) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return p.day + '/' + p.month + ' ' + p.hour + ':' + p.minute;
};
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra).slice(0, 1500))); if (!ok) failed++; };

try {
  await wait(800);
  // 1) first WhatsApp message creates the live mirror with both messages
  let k = await turn('ALFA primeira mensagem');
  let ms = await mirrors();
  check('mirror created for the WhatsApp session', ms.length === 1, ms);
  const m1 = ms[0] || {};
  check('mirror chatView: web kind, channel whatsapp, origin, live', m1.kind === 'web' && m1.channel === 'whatsapp' && m1.origin === W && m1.live === true, m1);
  check('origin chatView points to the mirror', (await view(W)).mirror === m1.id && (await view(W)).channel === 'whatsapp' && (await view(W)).live === false, await view(W));
  let h = await msgs(m1.id);
  check('user and bot messages mirrored', h.length === 2 && h[0].role === 'user' && h[0].text === 'ALFA primeira mensagem' && h[1].role === 'assistant' && /respondeu a: ALFA/.test(h[1].text), h);
  check('mirror title set', await until(async () => /Assunto ALFA|ALFA primeira/.test((await view(m1.id)).title)), (await view(m1.id)).title);
  const plain = (await api('POST', '/web', {})).body;
  check('plain web chat: channel web, not live', plain.channel === 'web' && plain.live === false && plain.origin === '', plain);

  k = await turn('ALFA segunda');
  const sessA = k[0] && k[0].resume;
  check('WhatsApp resumes its session', Boolean(sessA), k);

  // 2) panel on the LIVE mirror: same session id, answer only in the panel, WhatsApp continues the same session
  const sentBefore = sent.length;
  k = await panel(m1.id, 'PAINEL-AO-VIVO pergunta');
  check('live mirror from the panel resumes the WhatsApp session id', k.length === 1 && k[0].resume === sessA, k);
  check('panel answer not echoed to WhatsApp', !sent.slice(sentBefore).some((m) => /PAINEL-AO-VIVO/.test(m.text)), sent.slice(sentBefore));
  check('origin keeps the same session', (await view(W)).session === sessA, await view(W));
  k = await turn('ALFA de volta ao whats');
  check('back on WhatsApp: same session, in sync (no context block)', k[0] && k[0].resume === sessA && !k[0].prompt.includes('[Contexto da conversa'), k);
  h = await msgs(m1.id);
  check('mirror history has whatsapp + panel turns', h.length === 8 && h.some((m) => m.text === 'PAINEL-AO-VIVO pergunta'), h.map((m) => m.text));

  // 3) /new freezes the session (with its id) and the next message opens a new mirror
  await cmd('/new', /Nova conversa/);
  let v1 = await view(m1.id);
  check('/new: old mirror archived with its session id', v1.live === false && v1.session === sessA, v1);
  check('/new: origin detached and reset', !(await view(W)).mirror && !(await view(W)).session, await view(W));
  k = await turn('BETA outro assunto');
  check('new session starts fresh', k[0] && !k[0].resume && !k[0].prompt.includes('ALFA'), k);
  ms = await mirrors();
  const m2 = ms.find((x) => x.id !== m1.id) || {};
  check('second mirror is live', ms.length === 2 && m2.live === true && (await view(W)).mirror === m2.id, ms);
  k = await turn('BETA segunda');
  const sessB = k[0] && k[0].resume;
  check('second session has its own id', sessB && sessB !== sessA, k);

  // 4) /session lists newest first, SP time, current marked
  const listMsg = await cmd('/session', /Últimas sessões/);
  const lines = String(listMsg && listMsg.text || '').split('\n').filter((l) => /^\d+\. /.test(l));
  const t1 = await view(m1.id), t2 = await view(m2.id);
  check('/session lists 2 numbered sessions', lines.length === 2, listMsg);
  check('/session newest first, current marked', lines[0] && lines[0].startsWith('1. ') && lines[0].includes('(atual)') && lines[0].includes(t2.title.slice(0, 20)) && !lines[1].includes('(atual)'), lines);
  check('/session dates in America/Sao_Paulo', lines[0] && lines[0].includes('— ' + spDate(t2.updated)) && lines[1].includes('— ' + spDate(t1.updated)), { lines, u2: t2.updated, u1: t1.updated });
  check('/session has no table and explains N', !/\|/.test(listMsg.text) && /\/session N/.test(listMsg.text), listMsg.text);

  // 5) answering with the number resumes the old session
  const conf = await cmd('2', /Sessão retomada/);
  check('reply with the number resumes, with title', conf && conf.text.includes(t1.title.slice(0, 20)), conf);
  check('session id restored on the origin', (await view(W)).session === sessA && (await view(W)).mirror === m1.id, await view(W));
  check('live flags switched', (await view(m1.id)).live === true && (await view(m2.id)).live === false && (await view(m2.id)).session === sessB, [await view(m1.id), await view(m2.id)]);
  k = await turn('ALFA retomada');
  check('WhatsApp continues the resumed session id', k[0] && k[0].resume === sessA, k);
  check('resumed messages go to the resumed mirror', (await msgs(m1.id)).some((m) => m.text === 'ALFA retomada') && !(await msgs(m2.id)).some((m) => m.text === 'ALFA retomada'));

  // 6) panel on an ARCHIVED mirror uses its frozen session id and leaves the WhatsApp session alone
  k = await panel(m2.id, 'PAINEL-ARQUIVADA continua');
  check('archived mirror from the panel resumes its own session id', k.length === 1 && k[0].resume === sessB, k);
  check('origin untouched by the archived run', (await view(W)).session === sessA && (await view(W)).mirror === m1.id, await view(W));

  // 7) /sessions alias + /session N by number, unknown number
  await cmd('/sessions', /Últimas sessões/);
  const c2 = await cmd('/session 9', /não encontrada/);
  check('/session with an invalid number', Boolean(c2));
  const c3 = await cmd('/session 1', /Sessão retomada|já está/);
  check('/session N works by argument', Boolean(c3), sent.slice(-3));

  // 7b) /new typed in the panel on the live mirror starts a new session on WhatsApp
  const liveBefore = (await view(W)).mirror;
  await api('POST', '/web/' + liveBefore.slice(4) + '/messages', { text: '/new' });
  await until(async () => !(await view(W)).mirror);
  check('panel /new on the live mirror archives it and resets the origin', !(await view(W)).mirror && !(await view(W)).session && (await view(liveBefore)).live === false && Boolean((await view(liveBefore)).session), [await view(W), await view(liveBefore)]);
  await cmd('/session ' + liveBefore, /Sessão retomada|já está/);
  check('resumed again after panel /new', (await view(W)).mirror === liveBefore, await view(W));
  // 7c) race: /new on WhatsApp while the panel runs on the live mirror must not leak the old session id into the new one
  const raceLive = (await view(W)).mirror;
  const raceSess = (await view(W)).session;
  const nRace = (await msgs(raceLive)).length;
  await api('POST', '/web/' + raceLive.slice(4) + '/messages', { text: 'LENTO painel corrida' });
  await wait(800);
  await cmd('/new', /Nova conversa/);
  await until(async () => (await msgs(raceLive)).slice(nRace).some((m) => m.role === 'assistant'));
  await wait(300);
  check('race: /new during a panel turn keeps the origin reset', !(await view(W)).session && !(await view(W)).mirror && (await view(raceLive)).session === raceSess, [await view(W), await view(raceLive)]);
  k = await turn('DELTA depois da corrida');
  check('race: next WhatsApp message starts a fresh session', k[0] && !k[0].resume, k);
  // /session N while the panel runs on the live mirror is refused (the turn would write back the wrong session)
  const raceLive2 = (await view(W)).mirror;
  await api('POST', '/web/' + raceLive2.slice(4) + '/messages', { text: 'LENTO painel corrida 2' });
  await wait(800);
  const refused = await cmd('/session ' + raceLive, /tarefa em andamento|Sessão retomada/);
  check('race: /session N refused while the panel runs on the live session', refused && /tarefa em andamento/.test(refused.text), refused);
  await until(async () => (await msgs(raceLive2)).some((m) => m.role === 'assistant' && /LENTO painel corrida 2/.test(m.text)));
  await cmd('/session ' + liveBefore, /Sessão retomada|já está/);
  // 7d) /new while a WhatsApp turn runs: refused, the reply goes to the turn's mirror, no orphan mirror, no id leak
  {
    const liveD = (await view(W)).mirror, sessD = (await view(W)).session, nMirrors = (await mirrors()).length;
    const runsBefore = (await view(liveD)).totals.runs;
    const n0 = sent.length;
    await wa('LENTO whatsapp turno');
    await wait(800);
    const refusedNew = await cmd('/new', /tarefa em andamento|Nova conversa/);
    check('/new refused while a WhatsApp turn runs', refusedNew && /tarefa em andamento/.test(refusedNew.text), refusedNew);
    await until(() => sent.slice(n0).some((m) => /respondeu a: LENTO whatsapp turno/.test(m.text)));
    await wait(300);
    check('reply of the running turn stays in its mirror (no orphan)', (await mirrors()).length === nMirrors && (await msgs(liveD)).some((m) => /respondeu a: LENTO whatsapp turno/.test(m.text)), await mirrors());
    check('origin keeps the session (no reset mid-turn)', (await view(W)).session === sessD && (await view(W)).mirror === liveD, await view(W));
    // 3) mirror counts the WhatsApp turns and they are not unread
    const vD = await view(liveD);
    check('mirror totals.runs counts WhatsApp turns', vD.totals.runs === runsBefore + 1 && vD.runs.length > 0 && vD.unread === false, vD.totals);
    // 4) /stop on WhatsApp stops a panel turn on the live mirror
    const nD = (await msgs(liveD)).length;
    await api('POST', '/web/' + liveD.slice(4) + '/messages', { text: 'LENTO painel para parar' });
    await wait(800);
    const stopped = await cmd('/stop', /Interrompid|Nada em andamento/);
    check('/stop on WhatsApp interrupts the panel turn on the live session', stopped && /painel/.test(stopped.text), stopped);
    await until(async () => (await msgs(liveD)).slice(nD).some((m) => m.role === 'assistant'));
    check('panel turn marked as stopped', (await msgs(liveD)).slice(nD).some((m) => m.role === 'assistant' && m.stopped), (await msgs(liveD)).slice(nD));
    await wait(300);
  }
  // 2) /session typed in the panel answers with a hint, not the model
  {
    const before = calls().length;
    await api('POST', '/web/' + plain.id.slice(4) + '/messages', { text: '/session' });
    await until(async () => (await msgs(plain.id)).some((m) => m.role === 'assistant'));
    const hint = (await msgs(plain.id)).find((m) => m.role === 'assistant');
    check('/session in the panel: hint, no model call', hint && /WhatsApp e do Telegram/.test(hint.text) && calls().length === before, hint);
  }
  // 8) help and panel commands
  const help = await cmd('/help', /Todos os comandos/);
  check('/help mentions /session', help && help.text.includes('/session'), help && help.text);
  // deleting the live mirror detaches it from the origin
  const live = (await view(W)).mirror;
  await api('DELETE', '/chats/' + live);
  check('deleting the live mirror clears the origin link', !(await view(W)).mirror, await view(W));
  k = await turn('GAMA depois do delete');
  ms = await mirrors();
  check('next message creates a new live mirror', ms.some((x) => x.live && x.id !== live), ms);
} catch (e) { console.log('FAIL exception', e.stack); failed++; }
bridge.kill(); waha.close();
if (failed) console.log(logs.slice(-3000));
console.log(failed ? 'WA SESSIONS FAIL (' + failed + ')' : 'WA SESSIONS OK');
process.exit(failed ? 1 : 0);
