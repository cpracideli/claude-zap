// Local test of Phase 3 (Pages: HTML dashboards, public share links, revision history) and Phase 6 (Prompt/approval cards, unread state).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-pages'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
const PORT = 4052, TOKEN = 'tok-pages', W = '5511999990000@c.us';
const fakeClaude = path.join(tmp, 'claude.mjs');

fs.writeFileSync(fakeClaude, `
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
if (a[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const msgs = []; let buf = ''; let wake = null;
if (a.includes('--input-format')) {
  process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    try { msgs.push(JSON.parse(l).message.content.map((x) => x.text || '').join('')); } catch {} if (wake) wake(); } });
  process.stdin.on('error', () => {});
} else { msgs.push(get('-p') || ''); }
while (!msgs.length) await new Promise((r) => { wake = r; setTimeout(r, 50); });
const p = msgs[0];
let extra = '';
if (p.includes('ASK_PROMPT')) {
  const r = await fetch('http://127.0.0.1:${PORT}/prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: process.env.WA_CHAT_ID, title: 'Confirmar deploy', question: 'Deseja publicar agora?', options: ['Aprovar', 'Adiar'], wait: 20 })
  });
  const j = await r.json();
  extra = ' PROMPT_ANS=' + j.answer + (j.note ? '(' + j.note + ')' : '');
}
if (p.includes('ASK_RICH')) {
  const r = await fetch('http://127.0.0.1:${PORT}/prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatId: process.env.WA_CHAT_ID, title: 'Arquitetura',
      multiSelect: true,
      questions: [
        { question: 'Quais módulos ativar?', multiSelect: true, options: [{ label: 'Cache', description: 'Redis local', recommended: true }, { label: 'Fila', description: 'Worker async' }] },
        { question: 'Ambiente?', options: [{ label: 'Staging', recommended: true }, { label: 'Prod' }] }
      ],
      wait: 20
    })
  });
  const j = await r.json();
  extra = ' RICH_ANS=' + JSON.stringify(j.answers || j.answer);
}
if (p.includes('CHECK_SYS_PROMPT')) {
  const sp = get('--append-system-prompt') || '';
  extra = ' SYS_SUG_WA=' + (sp.includes('SUGESTÕES RÁPIDAS') && sp.includes('enquete clicável no WhatsApp') && sp.includes('nova mensagem no chat'));
}
if (p.includes('WITH_SUG_WA')) {
  extra = '\\n\\n\`\`\`suggestions\\n[{"label":"Fazer deploy","description":"Publica agora","text":"Executar deploy em producao"},{"label":"Ver diff"},{"label":"Ver status","text":"/status"}]\\n\`\`\`';
} else if (p.includes('WITH_ONE_SUG')) {
  extra = '\\n\\n\`\`\`suggestions\\n[{"label":"Unica acao","text":"Rodar acao unica"}]\\n\`\`\`';
} else if (p.includes('WITH_SUG')) {
  extra = '\\n\\n\`\`\`suggestions\\n[{"label":"Fazer deploy","description":"Publica agora"},{"label":"Ver diff"}]\\n\`\`\`';
}
console.log(JSON.stringify({ type: 'result', result: 'OK:' + p.slice(0, 40) + extra, session_id: 's1', is_error: false, num_turns: 1, duration_ms: 10, total_cost_usd: 0 }));
process.exit(0);
`);

const sent = [];
const wahaCalls = [];
let pollSeq = 1;
let failNextPoll = false;
const waha = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  let j = null; try { j = b ? JSON.parse(b) : null; } catch {}
  wahaCalls.push({ url: req.url, body: j });
  if (req.url === '/api/sendText' && j) sent.push(j.text);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/sendPoll') {
    if (failNextPoll) { failNextPoll = false; res.writeHead(500); return res.end('{"error":"poll failed"}'); }
    return res.end(JSON.stringify({ id: 'true_' + W + '_SUGPOLL' + (pollSeq++) }));
  }
  res.end('{"id":"m1"}');
}); }).listen(4051);
fs.mkdirSync(path.join(tmp, '.bridge')); fs.writeFileSync(path.join(tmp, '.bridge', 'chats.json'), JSON.stringify({ [W]: {} }));
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'), BRIDGE_ADMIN_TOKEN: TOKEN,
    ALLOWED_NUMBERS: '5511999990000', WAHA_URL: 'http://127.0.0.1:4051', WAHA_SESSION: 'S', STARTUP_NOTICE: 'false', AI_MEMORY: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; bridge.stdout.on('data', (d) => { logs += d; }); bridge.stderr.on('data', (d) => { logs += d; });
const base = 'http://127.0.0.1:' + PORT;
const api = async (method, p, body) => {
  const r = await fetch(base + '/admin' + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const local = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const wa = (text) => fetch(base + '/webhook', { method: 'POST', body: JSON.stringify({ event: 'message', session: 'S', payload: { id: 'x' + Math.random(), from: W, body: text } }) });
const waEvent = (event, payload) => fetch(base + '/webhook', { method: 'POST', body: JSON.stringify({ event, session: 'S', payload }) });
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } return null; };

try {
  await wait(800);

  // --- Phase 3: Pages ---
  let r = await local('POST', '/pages', { title: 'Painel de Vendas', description: 'Métricas do mês', html: '<h1>Vendas: R$ 10k</h1>', public: true });
  check('page created via local API', r.status === 200 && r.body.id === 'painel-de-vendas' && r.body.shareToken && r.body.revisions === 1, r.body);
  const pgId = r.body.id;
  const tok = r.body.shareToken;

  // public access
  const pubOk = await fetch(base + '/p/' + pgId + '/' + tok);
  check('public page accessible with valid token', pubOk.status === 200 && (await pubOk.text()).includes('Vendas: R$ 10k'));
  const pubBad = await fetch(base + '/p/' + pgId + '/wrongtoken');
  check('public page 404 with wrong token', pubBad.status === 404);

  // update page -> keeps history
  r = await api('PATCH', '/pages/' + pgId, { html: '<h1>Vendas: R$ 25k</h1>', title: 'Painel de Vendas Q4' });
  check('page updated and revision incremented', r.status === 200 && r.body.revisions === 2 && r.body.history.length === 1, r.body);

  // raw html via admin
  const rawRes = await fetch(base + '/admin/pages/' + pgId + '/raw', { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('admin raw html returns updated html', rawRes.status === 200 && (await rawRes.text()).includes('R$ 25k'));

  // restore previous version
  const histAt = r.body.history[0].at;
  r = await api('POST', '/pages/' + pgId + '/restore', { at: histAt });
  check('page restore reverts html', r.status === 200 && r.body.html.includes('R$ 10k') && r.body.revisions === 3, r.body);

  // make private -> public link stops working
  await api('PATCH', '/pages/' + pgId, { public: false });
  check('private page returns 404 on public url', (await fetch(base + '/p/' + pgId + '/' + tok)).status === 404);

  // overview counts pages
  check('overview includes pages count', (await api('GET', '/overview')).body.pages === 1);

  // delete page
  r = await api('DELETE', '/pages/' + pgId);
  check('page deleted', r.status === 200 && (await api('GET', '/pages')).body.length === 0);

  // --- Phase 6: Interactive Prompt / Approval Cards (Web) ---
  const c = (await api('POST', '/web', { title: 'Approval Chat' })).body;
  await api('POST', '/web/' + c.id.slice(4) + '/messages', { text: 'ASK_PROMPT por favor' });
  const pending = await until(async () => {
    const ch = (await api('GET', '/chats')).body.find((x) => x.id === c.id);
    return ch && ch.pendingPrompt;
  });
  check('web chat exposes pendingPrompt while waiting', pending && pending.title === 'Confirmar deploy' && pending.options.includes('Aprovar'), pending);
  check('overview counts pendingPrompts', (await api('GET', '/overview')).body.pendingPrompts === 1);

  // Answer the prompt from the panel
  r = await api('POST', '/prompts/' + pending.id + '/answer', { answer: 'Aprovar', note: 'pode ir' });
  check('prompt answered via panel API', r.status === 200 && r.body.status === 'answered' && r.body.answer === 'Aprovar', r.body);

  // Agent receives the answer and finishes the turn
  const rep = await until(async () => {
    const ms = (await api('GET', '/web/' + c.id.slice(4) + '/messages?read=0')).body.messages;
    return ms.find((m) => m.role === 'assistant');
  });
  check('agent run received prompt answer and finished', rep && rep.text.includes('PROMPT_ANS=Aprovar(pode ir)'), rep);
  check('assistant message stores prompts card', rep && rep.prompts && rep.prompts[0].answer === 'Aprovar', rep);

  // Unread tracking
  const chUnread = (await api('GET', '/chats')).body.find((x) => x.id === c.id);
  check('chat marked unread when read=0', chUnread && chUnread.unread === true, chUnread);
  await api('GET', '/web/' + c.id.slice(4) + '/messages'); // default marks read
  const chRead = (await api('GET', '/chats')).body.find((x) => x.id === c.id);
  check('chat marked read after opening messages', chRead && chRead.unread === false, chRead);

  // --- Phase 6: Interactive Prompt on WhatsApp ---
  sent.length = 0;
  await wa('ASK_PROMPT no zap');
  const menuMsg = await until(() => sent.find((x) => x.includes('Confirmar deploy')));
  check('whatsapp receives numbered approval card', Boolean(menuMsg), sent);
  await wa('1'); // picks option 1 ("Aprovar")
  const waAns = await until(() => sent.find((x) => x.includes('PROMPT_ANS=Aprovar')));
  check('whatsapp numeric reply answers prompt and unblocks agent', Boolean(waAns), sent);

  // --- Rich AskUserQuestion prompts (options objects, multiSelect, questions) ---
  const cRich = (await api('POST', '/web', { title: 'Rich Prompt Chat' })).body;
  await api('POST', '/web/' + cRich.id.slice(4) + '/messages', { text: 'ASK_RICH' });
  const richPending = await until(async () => {
    const ch = (await api('GET', '/chats')).body.find((x) => x.id === cRich.id);
    return ch && ch.pendingPrompt;
  });
  check('rich prompt exposes optionItems, multiSelect and questions', richPending
    && Array.isArray(richPending.optionItems) && richPending.optionItems[0].recommended === true && richPending.optionItems[0].description === 'Redis local'
    && richPending.multiSelect === true && Array.isArray(richPending.questions) && richPending.questions.length === 2, richPending);
  r = await api('POST', '/prompts/' + richPending.id + '/answer', {
    answer: '1) Cache, Fila | 2) Staging',
    answers: [{ question: 'Quais módulos ativar?', answer: ['Cache', 'Fila'] }, { question: 'Ambiente?', answer: 'Staging' }],
  });
  check('rich prompt answered with structured answers', r.status === 200 && Array.isArray(r.body.answers) && r.body.answers.length === 2, r.body);
  const richRep = await until(async () => {
    const ms = (await api('GET', '/web/' + cRich.id.slice(4) + '/messages?read=0')).body.messages;
    return ms.find((m) => m.role === 'assistant');
  });
  check('agent received structured rich answers', richRep && richRep.text.includes('RICH_ANS=') && richRep.text.includes('Staging'), richRep);

  // --- Archived chat excluded from overview.unread + webRunning exposed ---
  const ovBeforeArch = (await api('GET', '/overview')).body;
  check('unread counts unarchived unread web chat & exposes webRunning', ovBeforeArch.unread >= 1 && Array.isArray(ovBeforeArch.webRunning), ovBeforeArch);
  await api('PATCH', '/chats/' + encodeURIComponent(cRich.id), { archived: true });
  const ovAfterArch = (await api('GET', '/overview')).body;
  check('archived chat excluded from overview.unread', ovAfterArch.unread === 0, ovAfterArch);

  // --- Non-blocking quick-reply suggestions (Web) ---
  const cSug = (await api('POST', '/web', { title: 'Suggestions Chat' })).body;
  await api('POST', '/web/' + cSug.id.slice(4) + '/messages', { text: 'WITH_SUG' });
  const sugRep = await until(async () => {
    const ms = (await api('GET', '/web/' + cSug.id.slice(4) + '/messages')).body.messages;
    return ms.find((m) => m.role === 'assistant');
  });
  check('suggestions block parsed and stripped from text', sugRep && !sugRep.text.includes('```suggestions') && Array.isArray(sugRep.suggestions) && sugRep.suggestions.length === 2 && sugRep.suggestions[0].label === 'Fazer deploy', sugRep);

  // --- Non-blocking quick-reply suggestions on WhatsApp (poll + vote dispatch + system prompt + fallbacks) ---
  sent.length = 0; wahaCalls.length = 0;
  await wa('CHECK_SYS_PROMPT');
  const sysMsg = await until(() => sent.find((x) => x.includes('SYS_SUG_WA=')));
  check('whatsapp system prompt describes quick suggestions as WhatsApp poll', Boolean(sysMsg && sysMsg.includes('SYS_SUG_WA=true')), sysMsg);

  sent.length = 0; wahaCalls.length = 0;
  const pollSeqBefore = pollSeq;
  await wa('WITH_SUG_WA');
  const sugPoll = await until(() => wahaCalls.find((c) => c.url === '/api/sendPoll' && c.body?.chatId === W));
  const sugTextMsg = sent.find((x) => x.includes('OK:WITH_SUG_WA'));
  check('whatsapp reply strips raw ```suggestions block', Boolean(sugTextMsg && !sugTextMsg.includes('```suggestions') && !sugTextMsg.includes('Publica agora')), sent);
  check('whatsapp sends quick suggestions as WAHA poll after reply', Boolean(
    sugPoll
    && sugPoll.body.poll.multipleAnswers === false
    && Array.isArray(sugPoll.body.poll.options)
    && sugPoll.body.poll.options[0] === 'Fazer deploy — Publica agora'
    && sugPoll.body.poll.options[1] === 'Ver diff'
    && sugPoll.body.poll.options[2] === 'Ver status'
  ), sugPoll);
  const textIdx = wahaCalls.findIndex((c) => c.url === '/api/sendText' && String(c.body?.text || '').includes('OK:WITH_SUG_WA'));
  const pollIdx = wahaCalls.findIndex((c) => c.url === '/api/sendPoll');
  check('suggestions poll is sent after the text reply', textIdx >= 0 && pollIdx > textIdx, { textIdx, pollIdx });

  // Vote on option 1 (with custom text) -> dispatches custom text as new chat message
  const sugPollId = 'true_' + W + '_SUGPOLL' + pollSeqBefore;
  sent.length = 0;
  await waEvent('poll.vote', { poll: { id: sugPollId }, vote: { id: 'vsug-1', from: W, selectedOptions: ['Fazer deploy — Publica agora'] } });
  const voteReply1 = await until(() => sent.find((x) => x.includes('OK:Executar deploy em producao')));
  check('voting on suggestion poll dispatches suggestion text as new message', Boolean(voteReply1), sent);

  // Duplicate vote (same vote.id + picked) must be ignored
  const countBeforeDup = sent.filter((x) => x.includes('OK:Executar deploy em producao')).length;
  await waEvent('poll.vote', { poll: { id: sugPollId }, vote: { id: 'vsug-1', from: W, selectedOptions: ['Fazer deploy — Publica agora'] } });
  await wait(400);
  check('duplicate suggestion poll vote is ignored', sent.filter((x) => x.includes('OK:Executar deploy em producao')).length === countBeforeDup);

  // Vote from non-allowed number must be ignored
  await waEvent('poll.vote', { poll: { id: sugPollId }, vote: { id: 'vsug-bad', from: '5511000000000@c.us', selectedOptions: ['Ver diff'] } });
  await wait(400);
  check('suggestion poll vote from non-allowed sender is ignored', !sent.some((x) => x.includes('OK:Ver diff')));

  // Vote on option 2 (label only) -> dispatches label
  await waEvent('poll.vote', { poll: { id: sugPollId }, vote: { id: 'vsug-2', from: W, selectedOptions: ['Ver diff'] } });
  const voteReply2 = await until(() => sent.find((x) => x.includes('OK:Ver diff')));
  check('voting on label-only suggestion dispatches label as new message', Boolean(voteReply2), sent);

  // Vote on option 3 (slash command /status) -> executes bridge command
  sent.length = 0;
  await waEvent('poll.vote', { poll: { id: sugPollId }, vote: { id: 'vsug-3', from: W, selectedOptions: ['Ver status'] } });
  const cmdReply = await until(() => sent.find((x) => x.includes('Provedor') || x.includes('Modelo') || x.includes('Sessão')));
  check('voting on slash-command suggestion runs bridge command', Boolean(cmdReply), sent);

  // Single suggestion (<2 options) falls back to numbered menu and numeric reply dispatches text
  sent.length = 0; wahaCalls.length = 0;
  await wa('WITH_ONE_SUG');
  const oneMenu = await until(() => sent.find((x) => x.includes('1. Unica acao') && x.includes('Responda com o número')));
  check('single suggestion strips block and falls back to numbered menu', Boolean(oneMenu && !sent.some((x) => x.includes('```suggestions')) && !wahaCalls.some((c) => c.url === '/api/sendPoll')), sent);
  sent.length = 0;
  await wa('1');
  const oneDispatch = await until(() => sent.find((x) => x.includes('OK:Rodar acao unica')));
  check('replying 1 to single-suggestion fallback menu dispatches suggestion text', Boolean(oneDispatch), sent);

  // When /api/sendPoll fails (HTTP 500), falls back to numbered menu and numeric reply dispatches text
  sent.length = 0; wahaCalls.length = 0;
  failNextPoll = true;
  await wa('WITH_SUG_WA');
  const failMenu = await until(() => sent.find((x) => x.includes('1. Fazer deploy — Publica agora') && x.includes('2. Ver diff')));
  check('sendPoll failure falls back to numbered menu', Boolean(failMenu), sent);
  sent.length = 0;
  await wa('2');
  const failDispatch = await until(() => sent.find((x) => x.includes('OK:Ver diff')));
  check('replying 2 to poll-failure fallback menu dispatches option 2', Boolean(failDispatch), sent);

  // Scheduled task on WhatsApp with suggestions strips block and sends poll
  sent.length = 0; wahaCalls.length = 0;
  const sch = (await api('POST', '/schedules', { chatId: W, webhook: true, description: 'Briefing sug', prompt: 'WITH_SUG_WA' })).body;
  await fetch(base + '/hooks/' + sch.id + '/' + sch.hookToken, { method: 'POST', body: 'go' });
  const schPoll = await until(() => wahaCalls.find((c) => c.url === '/api/sendPoll' && c.body?.chatId === W));
  const schMsg = sent.find((x) => x.includes('⏰') && x.includes('OK:'));
  check('scheduled WhatsApp reply strips suggestions and sends poll', Boolean(schPoll && schMsg && !schMsg.includes('```suggestions')), { schMsg, schPoll });

} catch (err) {
  console.log('FAIL exception', err.stack);
  failed++;
}
bridge.kill(); waha.close();
if (failed) console.log(logs.slice(-3000));
console.log(failed ? 'PAGES/PROMPTS FAIL (' + failed + ')' : 'PAGES/PROMPTS OK');
process.exit(failed ? 1 : 0);
