// Provider handoff: switching provider mid-conversation (manual /provider, failover, light routing, going back to a
// previous provider) must carry the conversation context to whoever answers next. Fake claude, opencode and an
// OpenAI-compatible API log every prompt so we can check what each provider received.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-handoff'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
fs.mkdirSync(path.join(tmp, '.bridge'));
const LOG = path.join(tmp, 'calls.jsonl');

// Fake Claude Code: -p prompt, logs it; prompts containing FAILCLAUDE fail (for failover).
const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `
import fs from 'node:fs';
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
const p = get('-p') || '';
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ prov: 'claude', resume: get('--resume'), prompt: p }) + '\\n');
const last = p.split('\\n').filter(Boolean).pop() || '';
if (last.includes('FAILCLAUDE')) { console.error('boom: quota'); process.exit(1); }
const sid = get('--resume') || ('sess-' + Math.random().toString(36).slice(2, 8));
console.log(JSON.stringify({ type: 'result', result: 'CLAUDE respondeu a: ' + last, session_id: sid, is_error: false, num_turns: 1, duration_ms: 10 }));
`);
// Fake OpenCode CLI.
const fakeOc = path.join(tmp, 'opencode.mjs');
fs.writeFileSync(fakeOc, `
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('1.19.6'); process.exit(0); }
if (a[0] === 'models') { console.log('opencode/free-a'); process.exit(0); }
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : '';
const prompt = a[a.indexOf('--') + 1] || '';
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ prov: 'opencode', resume: get('-s') || null, prompt }) + '\\n');
const sid = get('-s') || ('ses_' + Math.random().toString(36).slice(2, 8));
const last = prompt.split('\\n').filter(Boolean).pop() || '';
console.log(JSON.stringify({ type: 'text', sessionID: sid, part: { type: 'text', text: 'OPENCODE respondeu a: ' + last } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }));
`);
const fakeOcBin = path.join(tmp, 'opencode');
fs.writeFileSync(fakeOcBin, '#!/bin/sh\nexec ' + process.execPath + ' ' + fakeOc + ' "$@"\n', { mode: 0o755 });

// Fake OpenAI-compatible API (DeepSeek-like).
const compat = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  const j = JSON.parse(b || '{}');
  const msgs = j.messages || [];
  const user = msgs.filter((m) => m.role === 'user').pop();
  fs.appendFileSync(LOG, JSON.stringify({ prov: 'openai_compat', history: msgs.length, prompt: user ? user.content : '', all: msgs.map((m) => m.role + ':' + String(m.content || '').slice(0, 2000)).join('\n') }) + '\n');
  const last = String(user ? user.content : '').split('\n').filter(Boolean).pop() || '';
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'COMPAT respondeu a: ' + last } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
}); }).listen(4063);

const sent = [];
const waha = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  if (req.url === '/api/sendText') sent.push(JSON.parse(b)); res.setHeader('Content-Type', 'application/json'); res.end('{"id":"m1"}'); }); }).listen(4061);
const PORT = 4062, TOKEN = 'tok-hand', W = '5511999990000@c.us';
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'), OPENCODE_BIN: fakeOcBin,
    BRIDGE_ADMIN_TOKEN: TOKEN, ALLOWED_NUMBERS: '5511999990000', WAHA_URL: 'http://127.0.0.1:4061', WAHA_SESSION: 'S',
    STARTUP_NOTICE: 'false', AI_MEMORY: 'off', SCHEDULER_TICK_MS: '300', CLAUDE_STEERING: 'off', CLAUDE_EFFORT: '',
    OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:4063', OPENAI_COMPAT_API_KEY: 'x' },
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
const replies = (re) => sent.filter((m) => re.test(m.text)).length;
// Sends a message and waits for the reply (any provider), returns the provider calls it caused.
async function turn(text) {
  const before = calls().length, sentBefore = sent.length;
  await wa(text);
  await until(() => sent.slice(sentBefore).some((m) => /respondeu a:|Erro ao executar/.test(m.text)));
  await wait(150);
  return calls().slice(before);
}
async function cmd(text, re) { const n = sent.length; await wa(text); await until(() => sent.slice(n).some((m) => re.test(m.text))); }
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra).slice(0, 1500))); if (!ok) failed++; };

try {
  await wait(800);
  await api('PUT', '/settings', { openaiCompat: { enabled: true, baseUrl: 'http://127.0.0.1:4063', defaultModel: 'deepseek-chat' } });

  // 1) Claude starts a task
  let k = await turn('Comece a TAREFA-ALFA: migrar o banco para Postgres');
  check('claude answers the first turn, fresh session', k.length === 1 && k[0].prov === 'claude' && !k[0].resume, k);
  const claudeSess = k[0] && k.length ? null : null;
  k = await turn('passo 2 da migração');
  check('same provider resumes without context block', k[0] && k[0].prov === 'claude' && k[0].resume && !k[0].prompt.includes('[Contexto da conversa'), k);
  const sess1 = k[0] && k[0].resume;

  // 2) manual switch to OpenCode: fresh session WITH the transcript
  await cmd('/provider opencode', /OpenCode/);
  k = await turn('continue a tarefa');
  check('opencode gets the context block on switch', k[0] && k[0].prov === 'opencode' && !k[0].resume && k[0].prompt.includes('[Contexto da conversa') && k[0].prompt.includes('TAREFA-ALFA') && k[0].prompt.includes('CLAUDE respondeu a: passo 2'), k[0] && k[0].prompt.slice(0, 1500));
  k = await turn('mais um passo OC');
  check('opencode resumes its session with no repeated context', k[0] && k[0].prov === 'opencode' && k[0].resume && !k[0].prompt.includes('[Contexto da conversa'), k);

  // 3) switch to openai_compat (DeepSeek): its own session key, gets the context
  await cmd('/provider openai_compat', /API Direta|openai_compat/);
  k = await turn('agora pelo deepseek');
  check('openai_compat gets the context block', k[0] && k[0].prov === 'openai_compat' && k[0].prompt.includes('TAREFA-ALFA') && k[0].prompt.includes('OPENCODE respondeu a: mais um passo OC'), k[0] && k[0].prompt.slice(0, 1500));
  k = await turn('deepseek de novo');
  check('openai_compat keeps its history on the next turn (no repeated context)', k[0] && k[0].prov === 'openai_compat' && k[0].history > 2 && !k[0].prompt.includes('[Contexto da conversa'), k);

  // 4) back to Claude: resumes the OLD session but receives what happened in between (not the old turns again)
  await cmd('/provider claude', /Claude/);
  k = await turn('voltei pro claude');
  const p4 = (k[0] && k[0].prompt) || '';
  check('claude resumes its old session', k[0] && k[0].prov === 'claude' && k[0].resume === sess1, k);
  check('claude gets the missed turns (opencode + deepseek)', p4.includes('continue a tarefa') && p4.includes('OPENCODE respondeu a') && p4.includes('COMPAT respondeu a: deepseek de novo'), p4.slice(0, 2000));
  check('claude delta does not repeat what it already knows', !p4.includes('Comece a TAREFA-ALFA'), p4.slice(0, 800));
  k = await turn('segue claude');
  check('in sync again: no context block', k[0] && !k[0].prompt.includes('[Contexto da conversa'), k);

  // 5) failover: claude fails, opencode takes over with context; its session goes to ocSession, not to claude's
  await api('PUT', '/settings', { routing: { enabled: true, fallbackOrder: ['opencode'], lightRouting: false } });
  k = await turn('FAILCLAUDE agora');
  const fo = k.find((x) => x.prov === 'opencode');
  check('failover provider receives the conversation context', Boolean(fo && !fo.resume && fo.prompt.includes('TAREFA-ALFA') && fo.prompt.includes('segue claude')), k);
  k = await turn('depois do failover');
  const c5 = k[0] || {};
  check('claude keeps its own session after failover (not the opencode id)', c5.prov === 'claude' && c5.resume === sess1, k);
  check('claude receives the failover turn as missed context', (c5.prompt || '').includes('FAILCLAUDE agora') && (c5.prompt || '').includes('OPENCODE respondeu a'), (c5.prompt || '').slice(0, 1500));
  await api('PUT', '/settings', { routing: { enabled: false } });

  // 6) /new clears everything: no context from the old conversation
  await cmd('/new', /Nova conversa/);
  k = await turn('assunto novo');
  check('/new: fresh session and no old context', k[0] && !k[0].resume && !k[0].prompt.includes('TAREFA-ALFA'), k);

  // 7) light routing: a light first message goes to opencode; the next (heavy) one goes to claude with that context
  await cmd('/new', /Nova conversa/);
  // the chat has an explicit provider from /provider claude; light routing only applies with no chat override
  await api('PATCH', '/chats/' + encodeURIComponent(W), { provider: '' });
  await api('PUT', '/settings', { routing: { enabled: false, lightRouting: true, lightProvider: 'opencode', lightModel: 'opencode/free-a' } });
  k = await turn('bom dia, tudo bem?');
  check('light prompt routed to opencode', k[0] && k[0].prov === 'opencode', k);
  k = await turn('agora crie o arquivo relatorio.md com o resumo');
  const p7 = (k[0] && k[0].prompt) || '';
  check('next provider (claude) gets the light-routed turn as context', k[0] && k[0].prov === 'claude' && !k[0].resume && p7.includes('bom dia, tudo bem?') && p7.includes('OPENCODE respondeu a'), k);

  // 8) /status shows the session of the current provider
  await cmd('/status', /\*Status\*/);
  const st = sent.filter((m) => /\*Status\*/.test(m.text)).pop();
  check('/status shows session', Boolean(st && /Sessão: sess-/.test(st.text)), st && st.text);
} catch (e) {
  check('no exception', false, e.stack);
} finally {
  bridge.kill('SIGTERM'); waha.close(); compat.close();
  console.log(failed ? failed + ' FAILED' : 'ALL OK');
  if (failed) console.log(logs.slice(-3000));
  process.exit(failed ? 1 : 0);
}
