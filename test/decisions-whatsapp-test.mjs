// End-to-end tests for mirroring every Action Inbox / Decision screen item to owner WhatsApp:
// 1. Web prompt mirrored to WhatsApp (text + poll + origin + panelUrl) -> answered via WA poll vote, numeric text, 👍/👎 reaction, and PIN
// 2. Direct WhatsApp prompt NOT duplicated
// 3. Secret request from Web mirrored to WhatsApp
// 4. Nudge from Web mirrored to WhatsApp (including "Ver rascunho" delivered to WA + no duplication on direct WA nudge)
// 5. Delegation chat prompt mirrored to WhatsApp and answerable from WhatsApp
// 6. Assisted Drafts: WhatsApp draft + scheduled Email draft notification + sendDraft failure notification
// 7. Tickets: create in todo (silent), create in review/blocked (notifies), patch transitions (notifies once, no renotify on same status), interrupted transition (notifies once), runTicket -> review/blocked
// 8. Boot recovery of interrupted tickets (`recoverPendingJobs`) sends consolidated WhatsApp notification
// 9. Multi-step workflow approval mirrored to WhatsApp WITHOUT duplication and resumed from WhatsApp vote/text
// 10. Safe no-op when ALLOWED_NUMBERS is empty or WAHA_URL is absent
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const bridgePath = path.join(dir, '..', 'bridge', 'bridge.mjs');
const bridgeSrc = fs.readFileSync(bridgePath, 'utf8');
assert.equal(bridgeSrc.includes('$'), false, 'bridge.mjs MUST NOT contain dollar sign ($)');

const tmp = path.join(dir, 'tmp-decisions-wa');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, '.bridge'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'workspace', 'inbox'), { recursive: true });

const PORT = 4096;
const WAHA_PORT = 4095;
const TOKEN = 'tok-decisions-wa';
const OWNER_NUM = '5511999990000';
const W = OWNER_NUM + '@c.us';
const W_LID = '198765432109876@lid';
const PANEL_URL = 'https://panel.decisions.test';

// Pre-seed two in_progress tickets to verify boot recovery notification (recoverPendingJobs)
fs.writeFileSync(path.join(tmp, '.bridge', 'tickets.json'), JSON.stringify([
  { id: 'rec001', title: 'Migrar banco prod', description: 'Estava rodando antes do restart', status: 'in_progress', priority: 'high', bot: 'default', interrupted: false, comments: [], created: '2026-11-22T10:00:00.000Z', updated: '2026-11-22T10:00:00.000Z' },
  { id: 'rec002', title: 'Gerar relatório mensal', description: 'Em execução', status: 'in_progress', priority: 'medium', bot: 'default', interrupted: false, comments: [], created: '2026-11-22T10:05:00.000Z', updated: '2026-11-22T10:05:00.000Z' },
], null, 2));
fs.writeFileSync(path.join(tmp, '.bridge', 'chats.json'), JSON.stringify({
  [W]: {},
  [W_LID]: {},
  'deleg:dec123': { title: 'Delegação Backend', bot: 'default' },
}, null, 2));
fs.writeFileSync(path.join(tmp, '.bridge', 'settings.json'), JSON.stringify({
  panelUrl: PANEL_URL,
}, null, 2));

const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : '';
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
if (p.includes('WEB_ASK_POLL')) {
  const r = await fetch('http://127.0.0.1:${PORT}/prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: process.env.WA_CHAT_ID, title: 'Aprovar release', question: 'Publicar v2.0 agora?', options: ['Aprovar', 'Adiar'], wait: 20 })
  });
  const j = await r.json();
  extra = ' WEB_POLL_ANS=' + j.answer;
} else if (p.includes('WEB_ASK_TEXT')) {
  const r = await fetch('http://127.0.0.1:${PORT}/prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: process.env.WA_CHAT_ID, title: 'Escolher banco', question: 'Qual banco usar?', options: ['PostgreSQL', 'SQLite'], wait: 20 })
  });
  const j = await r.json();
  extra = ' WEB_TEXT_ANS=' + j.answer;
} else if (p.includes('WEB_ASK_REACT')) {
  const r = await fetch('http://127.0.0.1:${PORT}/prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: process.env.WA_CHAT_ID, title: 'Confirmar limpeza', question: 'Limpar cache agora?', options: ['Sim', 'Não'], wait: 20 })
  });
  const j = await r.json();
  extra = ' WEB_REACT_ANS=' + j.answer;
} else if (p.includes('WA_DIRECT_ASK')) {
  const r = await fetch('http://127.0.0.1:${PORT}/prompts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: process.env.WA_CHAT_ID, title: 'Pergunta direta WA', question: 'Seguir direto?', options: ['Sim', 'Não'], wait: 20 })
  });
  const j = await r.json();
  extra = ' WA_DIRECT_ANS=' + j.answer;
} else if (p.includes('TICKET_FAIL')) {
  process.stderr.write('simulated ticket failure');
  process.exit(1);
}
console.log(JSON.stringify({ type: 'result', result: 'OK:' + p.slice(0, 60) + extra, session_id: 's-dec', is_error: false, num_turns: 1, duration_ms: 15, total_cost_usd: 0.01 }));
process.exit(0);
`);
fs.chmodSync(fakeClaude, 0o755);

const wahaCalls = [];
let pollSeq = 1;
let failRecipient = '';
const waha = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    let j = null;
    try { j = b ? JSON.parse(b) : null; } catch {}
    wahaCalls.push({ url: req.url, body: j });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/contacts/check-exists')) {
      const u = new URL(req.url, 'http://local');
      const phone = u.searchParams.get('phone');
      return res.end(JSON.stringify({ numberExists: true, chatId: phone + '@c.us' }));
    }
    if (req.url.startsWith('/api/S/lids/')) {
      const lid = decodeURIComponent(req.url.slice('/api/S/lids/'.length));
      if (lid === W_LID) return res.end(JSON.stringify({ lid: W_LID, pn: OWNER_NUM + '@c.us' }));
      return res.end(JSON.stringify({}));
    }
    if (req.url === '/api/sendText' && failRecipient && j && j.chatId === failRecipient) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: 'simulated WAHA failure' }));
    }
    if (req.url === '/api/sendPoll') {
      return res.end(JSON.stringify({ id: 'true_' + (j?.chatId || W) + '_DECPOLL' + (pollSeq++) }));
    }
    res.end('{"id":"m1"}');
  });
}).listen(WAHA_PORT);

const bridge = spawn(process.execPath, [bridgePath], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOME: tmp,
    CLAUDE_WORKDIR: path.join(tmp, 'workspace'),
    CLAUDE_BIN: fakeClaude,
    AGY_BIN: path.join(tmp, 'no-agy'),
    BRIDGE_ADMIN_TOKEN: TOKEN,
    ALLOWED_NUMBERS: OWNER_NUM,
    WAHA_URL: 'http://127.0.0.1:' + WAHA_PORT,
    WAHA_SESSION: 'S',
    STARTUP_NOTICE: 'false',
    AI_MEMORY: 'off',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
bridge.stdout.on('data', (d) => { logs += d; });
bridge.stderr.on('data', (d) => { logs += d; });

const base = 'http://127.0.0.1:' + PORT;
const api = async (method, p, body) => {
  const r = await fetch(base + '/admin' + p, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
};
const local = async (method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
};
const waEvent = (event, payload) => fetch(base + '/webhook', { method: 'POST', body: JSON.stringify({ event, session: 'S', payload }) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  return null;
};

let failed = 0;
let passed = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra)));
  if (ok) passed++;
  else failed++;
};
const waTexts = () => wahaCalls.filter((c) => c.url === '/api/sendText' && c.body?.chatId === W).map((c) => String(c.body.text || ''));
const waPolls = () => wahaCalls.filter((c) => c.url === '/api/sendPoll' && c.body?.chatId === W);

try {
  const healthy = await until(async () => {
    try { return (await local('GET', '/health')).status === 200; } catch { return false; }
  });
  check('bridge started healthy', Boolean(healthy));

  // 1) Boot recovery of interrupted tickets sends consolidated WhatsApp notification
  const bootMsg = await until(() => waTexts().find((t) => t.includes('2 tarefas interrompidas') && t.includes('#rec001') && t.includes('#rec002')));
  check('boot recovery notifies WhatsApp with consolidated interrupted tickets + board link', Boolean(bootMsg && bootMsg.includes(PANEL_URL + '/#/board')), waTexts());

  // 2) Web prompt mirrored to WhatsApp + answered via poll.vote
  wahaCalls.length = 0;
  const webChat = (await api('POST', '/web', { title: 'Deploy Prod' })).body;
  const pollSeqWeb1 = pollSeq;
  await api('POST', '/web/' + webChat.id.slice(4) + '/messages', { text: 'WEB_ASK_POLL' });
  const webPoll = await until(() => waPolls().find((c) => c.body?.poll?.name === 'Aprovar release'));
  const webCtx = waTexts().find((t) => t.includes('Aprovar release'));
  check('web prompt mirrored to WhatsApp with origin, panel chat link and native poll', Boolean(
    webPoll && webCtx && webCtx.includes('Painel Web (Deploy Prod)') && webCtx.includes(PANEL_URL + '/#/chat/' + webChat.id.slice(4))
  ), { webCtx, webPoll });
  await waEvent('poll.vote', {
    poll: { id: 'true_' + W + '_DECPOLL' + pollSeqWeb1 },
    vote: { id: 'v-web-1', from: W, selectedOptions: ['Aprovar'] },
  });
  const webRep1 = await until(async () => {
    const ms = (await api('GET', '/web/' + webChat.id.slice(4) + '/messages')).body.messages || [];
    return ms.find((m) => m.role === 'assistant' && m.text.includes('WEB_POLL_ANS=Aprovar'));
  });
  check('voting on mirrored WhatsApp poll answers Web prompt and unblocks agent', Boolean(webRep1), webRep1);

  // 3) Web prompt mirrored to WhatsApp + answered via numeric reply ("2")
  wahaCalls.length = 0;
  await api('POST', '/web/' + webChat.id.slice(4) + '/messages', { text: 'WEB_ASK_TEXT' });
  await until(() => waPolls().find((c) => c.body?.poll?.name === 'Escolher banco'));
  await waEvent('message', { id: 'm-num-1', from: W, body: '2' });
  const webRep2 = await until(async () => {
    const ms = (await api('GET', '/web/' + webChat.id.slice(4) + '/messages')).body.messages || [];
    return ms.find((m) => m.role === 'assistant' && m.text.includes('WEB_TEXT_ANS=SQLite'));
  });
  check('numeric WhatsApp reply answers mirrored Web prompt', Boolean(webRep2), webRep2);

  // 4) Web prompt mirrored to WhatsApp + answered via 👍/👎 reaction
  wahaCalls.length = 0;
  await api('POST', '/web/' + webChat.id.slice(4) + '/messages', { text: 'WEB_ASK_REACT' });
  await until(() => waPolls().find((c) => c.body?.poll?.name === 'Confirmar limpeza'));
  await waEvent('message.reaction', { from: W, reaction: { text: '👎', messageId: 'm1' } });
  const webRep3 = await until(async () => {
    const ms = (await api('GET', '/web/' + webChat.id.slice(4) + '/messages')).body.messages || [];
    return ms.find((m) => m.role === 'assistant' && m.text.includes('WEB_REACT_ANS=Não'));
  });
  check('WhatsApp 👎 reaction answers mirrored 2-option Web prompt', Boolean(webRep3), webRep3);

  // 5) Direct WhatsApp prompt MUST NOT be duplicated
  wahaCalls.length = 0;
  await waEvent('message', { id: 'm-wa-direct', from: W, body: 'WA_DIRECT_ASK' });
  await until(() => waPolls().find((c) => c.body?.poll?.name === 'Pergunta direta WA'));
  await wait(300);
  const directTexts = waTexts().filter((t) => t.includes('Pergunta direta WA'));
  const directPolls = waPolls().filter((c) => c.body?.poll?.name === 'Pergunta direta WA');
  check('direct WhatsApp prompt sent exactly once (no duplication)', directTexts.length === 1 && directPolls.length === 1, { directTexts, directPolls });
  await waEvent('message', { id: 'm-wa-direct-ans', from: W, body: '1' });
  const waDirectDone = await until(() => waTexts().find((t) => t.includes('WA_DIRECT_ANS=Sim')));
  check('direct WhatsApp prompt answered cleanly', Boolean(waDirectDone), waTexts());

  // 6) Secret request from Web mirrored to WhatsApp
  wahaCalls.length = 0;
  const secPromise = local('POST', '/secrets/request', { chatId: webChat.id, name: 'stripe_key', label: 'Chave Stripe', reason: 'Necessária para cobrar', wait: 5 });
  const secMsg = await until(() => waTexts().find((t) => t.includes('🔒 *Chave Stripe*')));
  check('secret request from Web mirrored to WhatsApp with security warning and link', Boolean(
    secMsg && secMsg.includes('Painel Web') && secMsg.includes('painel web') && secMsg.includes(PANEL_URL)
  ), secMsg);
  await waEvent('message', { id: 'm-sec-cancel', from: W, body: '1' });
  const secRes = await secPromise;
  check('secret request cancelled from WhatsApp numeric reply', secRes.status === 200 && secRes.body.status === 'answered' && secRes.body.answer === 'Cancelar', secRes.body);

  // 7) Nudge from Web mirrored to WhatsApp + "Ver rascunho" delivered on WA + direct WA nudge not duplicated
  wahaCalls.length = 0;
  const ndgWeb = await local('POST', '/nudges', {
    chatId: webChat.id, topicKey: 'web-nudge-1', title: 'Responder cliente X',
    summary: 'Cliente aguarda retorno desde ontem.', draft: 'Olá cliente X, segue atualização.',
    actionLabel: 'Enviar', actionPrompt: 'ENVIAR_CLIENTE_X',
  });
  check('web nudge created', ndgWeb.status === 200 && !ndgWeb.body.deduplicated, ndgWeb.body);
  const ndgPoll = await until(() => waPolls().find((c) => c.body?.poll?.name === 'Responder cliente X'));
  const ndgTxt = waTexts().find((t) => t.includes('💡 *Responder cliente X*'));
  check('web nudge mirrored to WhatsApp with 💡 icon, origin and poll', Boolean(ndgPoll && ndgTxt && ndgTxt.includes('Painel Web')), { ndgTxt, ndgPoll });
  await waEvent('message', { id: 'm-ndg-draft', from: W, body: '2' }); // "Ver rascunho"
  const waDraftShown = await until(() => waTexts().find((t) => t.includes('📝 *Rascunho — Responder cliente X*') && t.includes('segue atualização')));
  check('picking "Ver rascunho" on mirrored WhatsApp nudge sends draft text to WhatsApp', Boolean(waDraftShown), waTexts());

  wahaCalls.length = 0;
  await local('POST', '/nudges', { chatId: W, topicKey: 'wa-nudge-1', title: 'Nudge direto WA', summary: 'Resumo direto', actionLabel: 'OK', actionPrompt: 'DO_OK' });
  await until(() => waPolls().find((c) => c.body?.poll?.name === 'Nudge direto WA'));
  await wait(300);
  check('direct WhatsApp nudge not duplicated', waPolls().filter((c) => c.body?.poll?.name === 'Nudge direto WA').length === 1);
  await api('POST', '/prompts/' + (await api('GET', '/inbox')).body.nudges[0].id + '/answer', { answer: 'Ignorar' });

  // 8) Delegation chat prompt mirrored to WhatsApp and answerable from WhatsApp
  wahaCalls.length = 0;
  const delegPromptPromise = local('POST', '/prompts', { chatId: 'deleg:dec123', title: 'Aprovar migração delegada', question: 'Aplicar DDL?', options: ['Aprovar', 'Recusar'], wait: 5 });
  const delegMsg = await until(() => waTexts().find((t) => t.includes('Aprovar migração delegada')));
  check('delegation prompt mirrored to WhatsApp with Delegação origin', Boolean(delegMsg && delegMsg.includes('Delegação')), delegMsg);
  await waEvent('message', { id: 'm-deleg-ans', from: W, body: 'Aprovar' });
  const delegRes = await delegPromptPromise;
  check('delegation prompt answered via WhatsApp text', delegRes.status === 200 && delegRes.body.status === 'answered' && delegRes.body.answer === 'Aprovar', delegRes.body);

  // 9) Assisted Drafts: WhatsApp draft + scheduled Email draft + sendDraft failure
  wahaCalls.length = 0;
  const drWa = (await local('POST', '/drafts', { channel: 'whatsapp', to: '5511988887777', body: 'Oi João, **reunião** confirmada às 15h.' })).body;
  const drWaMsg = await until(() => waTexts().find((t) => t.includes('Rascunho aguardando decisão') && t.includes('5511988887777')));
  check('WhatsApp draft notifies owner WhatsApp with clean preview and panel link', Boolean(
    drWaMsg && drWaMsg.includes('*Canal:* WhatsApp') && drWaMsg.includes('reunião confirmada') && !drWaMsg.includes('**') && drWaMsg.includes(PANEL_URL)
  ), drWaMsg);

  wahaCalls.length = 0;
  const drMail = (await local('POST', '/drafts', {
    channel: 'email', to: 'diretor@empresa.com', subject: 'Status semanal',
    body: 'Segue o resumo das entregas da semana.', scheduledAt: '2026-12-01T12:00:00.000Z',
  })).body;
  const drMailMsg = await until(() => waTexts().find((t) => t.includes('diretor@empresa.com')));
  check('scheduled Email draft notifies owner WhatsApp with subject and schedule date', Boolean(
    drMailMsg && drMailMsg.includes('*Canal:* E-mail') && drMailMsg.includes('*Assunto:* Status semanal') && drMailMsg.includes('*Agendado para:*') && drMailMsg.includes(PANEL_URL)
  ), drMailMsg);

  wahaCalls.length = 0;
  failRecipient = '5511988887777@c.us';
  const sendFailRes = await api('POST', '/drafts/' + drWa.id + '/send');
  failRecipient = '';
  const drErrMsg = await until(() => waTexts().find((t) => t.includes('Falha ao enviar rascunho') && t.includes('5511988887777')));
  check('sendDraft failure sets error status and notifies owner WhatsApp', Boolean(
    sendFailRes.status === 400 && drErrMsg && drErrMsg.includes('simulated WAHA failure') && drErrMsg.includes(PANEL_URL)
  ), { sendFailRes, drErrMsg });
  await api('DELETE', '/drafts/' + drWa.id);
  await api('DELETE', '/drafts/' + drMail.id);

  // 10) Tickets: todo silent, create review/blocked notifies, patch transitions notify once without renotifying
  wahaCalls.length = 0;
  const tkTodo = (await local('POST', '/tickets', { title: 'Tarefa comum', status: 'todo', priority: 'low' })).body;
  await wait(250);
  check('creating todo ticket does NOT notify WhatsApp', waTexts().length === 0, waTexts());

  wahaCalls.length = 0;
  const tkRev = (await local('POST', '/tickets', { title: 'Revisar PR #42', description: 'Mudanças no endpoint /inbox', status: 'review', priority: 'high', bot: 'default' })).body;
  const tkRevMsg = await until(() => waTexts().find((t) => t.includes('#' + tkRev.id)));
  check('creating review ticket notifies WhatsApp with id, status and board link', Boolean(
    tkRevMsg && tkRevMsg.includes('Aguardando revisão') && tkRevMsg.includes('Revisar PR #42') && tkRevMsg.includes(PANEL_URL + '/#/board')
  ), tkRevMsg);

  wahaCalls.length = 0;
  const tkBlk = (await local('POST', '/tickets', { title: 'Aguardando credencial', status: 'blocked', priority: 'urgent' })).body;
  const tkBlkMsg = await until(() => waTexts().find((t) => t.includes('#' + tkBlk.id)));
  check('creating blocked ticket notifies WhatsApp', Boolean(tkBlkMsg && tkBlkMsg.includes('Bloqueada')), tkBlkMsg);

  // Patch todo -> review (notifies)
  wahaCalls.length = 0;
  await local('PATCH', '/tickets/' + tkTodo.id, { status: 'review' });
  const patchRevMsg = await until(() => waTexts().find((t) => t.includes('#' + tkTodo.id) && t.includes('Aguardando revisão')));
  check('patching ticket todo -> review notifies WhatsApp', Boolean(patchRevMsg), waTexts());

  // Patch same status (title/priority change while already review) -> MUST NOT renotify
  wahaCalls.length = 0;
  await local('PATCH', '/tickets/' + tkTodo.id, { title: 'Tarefa comum editada', status: 'review', priority: 'high' });
  await wait(300);
  check('patching ticket without status change does NOT renotify WhatsApp', waTexts().length === 0, waTexts());

  // Patch review -> blocked (notifies)
  wahaCalls.length = 0;
  await local('PATCH', '/tickets/' + tkTodo.id, { status: 'blocked' });
  const patchBlkMsg = await until(() => waTexts().find((t) => t.includes('#' + tkTodo.id) && t.includes('Bloqueada')));
  check('patching ticket review -> blocked notifies WhatsApp', Boolean(patchBlkMsg), waTexts());

  // Patch interrupted false -> true (notifies once), true -> true (silent)
  wahaCalls.length = 0;
  await local('PATCH', '/tickets/' + tkTodo.id, { status: 'in_progress' });
  await wait(200);
  check('patching ticket to in_progress does NOT notify WhatsApp', waTexts().length === 0, waTexts());
  await local('PATCH', '/tickets/' + tkTodo.id, { interrupted: true });
  const patchIntMsg = await until(() => waTexts().find((t) => t.includes('#' + tkTodo.id) && t.includes('Interrompida')));
  check('patching ticket interrupted false -> true notifies WhatsApp', Boolean(patchIntMsg), waTexts());
  wahaCalls.length = 0;
  await local('PATCH', '/tickets/' + tkTodo.id, { interrupted: true, priority: 'urgent' });
  await wait(300);
  check('patching already-interrupted ticket does NOT renotify WhatsApp', waTexts().length === 0, waTexts());

  // 11) Multi-step workflow approval on Web chat -> single WhatsApp notification (no duplicate), resumed via WA!
  wahaCalls.length = 0;
  const pg = (await api('POST', '/pages', { title: 'WF Page', html: '<h1>WF</h1>' })).body;
  const wf = (await api('POST', '/workflows', {
    name: 'Fluxo Aprovação WA',
    chatId: webChat.id,
    steps: [
      { id: 's1', name: 'Aprovar', type: 'approval', title: 'Aprovar fluxo WA', question: 'Executar etapa final?', options: ['Aprovar', 'Cancelar'] },
      { id: 's2', name: 'Gravar', type: 'page_data', pageId: pg.id, patch: { approvedViaWa: true } },
    ],
  })).body;
  const wfRun = (await api('POST', '/workflows/' + wf.id + '/run', { trigger: 'manual' })).body;
  check('workflow enters waiting_approval', wfRun.status === 'waiting_approval' && Boolean(wfRun.pendingPromptId), wfRun);
  await until(() => waPolls().find((c) => c.body?.poll?.name === 'Aprovar fluxo WA'));
  await wait(300);
  const wfTexts = waTexts().filter((t) => t.includes('Aprovar fluxo WA'));
  const wfPolls = waPolls().filter((c) => c.body?.poll?.name === 'Aprovar fluxo WA');
  check('workflow approval sends exactly ONE WhatsApp notification + ONE poll (no duplication)', wfTexts.length === 1 && wfPolls.length === 1, { wfTexts, wfPolls });
  // Approve directly via WhatsApp text "1"
  await waEvent('message', { id: 'm-wf-approve', from: W, body: '1' });
  const wfCompleted = await until(async () => {
    const runs = (await api('GET', '/workflows/runs')).body;
    const found = runs.find((r) => r.id === wfRun.id);
    return found && found.status === 'done' ? found : null;
  });
  const pgData = (await api('GET', '/pages/' + pg.id + '/data')).body;
  check('approving workflow via WhatsApp resumes and completes workflow', Boolean(wfCompleted && pgData.approvedViaWa === true), { wfCompleted, pgData });

  // 11b) Owner WhatsApp @lid replies (numeric text + reaction) answer mirrored prompts and Goal @lid notify deduplicates
  wahaCalls.length = 0;
  const lidTextPromise = local('POST', '/prompts', { chatId: webChat.id, title: 'Confirmar via LID', question: 'Rodar job via LID?', options: ['Executar', 'Cancelar'], wait: 8 });
  await until(() => waTexts().find((t) => t.includes('Confirmar via LID')));
  await waEvent('message', { id: 'm-lid-text', from: W_LID, body: '1' });
  const lidTextRes = await lidTextPromise;
  check('numeric WhatsApp reply from @lid answers mirrored Web prompt', lidTextRes.status === 200 && lidTextRes.body.status === 'answered' && lidTextRes.body.answer === 'Executar', lidTextRes.body);

  wahaCalls.length = 0;
  const lidReactPromise = local('POST', '/prompts', { chatId: webChat.id, title: 'Reagir via LID', question: 'Confirmar com reação?', options: ['Sim', 'Não'], wait: 8 });
  await until(() => waTexts().find((t) => t.includes('Reagir via LID')));
  await waEvent('message.reaction', { from: W_LID, reaction: { text: '👍', messageId: 'true_' + W_LID + '_lidreact1' } });
  const lidReactRes = await lidReactPromise;
  check('WhatsApp 👍 reaction from @lid answers mirrored 2-option Web prompt', lidReactRes.status === 200 && lidReactRes.body.status === 'answered' && lidReactRes.body.answer === 'Sim', lidReactRes.body);

  // Goal ticket with notifyChatId = W_LID finishing into review must send ONLY the goal notification (no duplicate decision notice)
  wahaCalls.length = 0;
  const tkGoalLid = (await local('POST', '/tickets', {
    title: 'Objetivo LID sem duplicar', description: 'Executar tarefa simples',
    status: 'todo', priority: 'medium', bot: 'default', goal: true, notifyChatId: W_LID,
  })).body;
  await api('POST', '/tickets/' + tkGoalLid.id + '/run');
  await until(async () => {
    const list = (await api('GET', '/tickets')).body;
    const found = (Array.isArray(list) ? list : list.tickets || []).find((x) => x.id === tkGoalLid.id);
    return found && found.status === 'review' ? found : null;
  });
  await wait(350);
  const goalLidCalls = wahaCalls.filter((c) => c.url === '/api/sendText' && (c.body?.chatId === W || c.body?.chatId === W_LID) && String(c.body.text || '').includes('#' + tkGoalLid.id));
  check('goal ticket with @lid notifyChatId sends single WhatsApp notice on review (no duplicate)', goalLidCalls.length === 1 && goalLidCalls[0].body.chatId === W_LID && String(goalLidCalls[0].body.text || '').includes('Objetivo #' + tkGoalLid.id), goalLidCalls);

  // 12) Safe no-op when ALLOWED_NUMBERS is empty and WAHA_URL is absent
  const tmpEmpty = path.join(dir, 'tmp-decisions-empty');
  fs.rmSync(tmpEmpty, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmpEmpty, '.bridge'), { recursive: true });
  const PORT2 = 4097;
  const b2 = spawn(process.execPath, [bridgePath], {
    env: {
      ...process.env,
      PORT: String(PORT2),
      HOME: tmpEmpty,
      CLAUDE_BIN: fakeClaude,
      AGY_BIN: path.join(tmpEmpty, 'no-agy'),
      BRIDGE_ADMIN_TOKEN: TOKEN,
      ALLOWED_NUMBERS: '',
      WAHA_URL: '',
      STARTUP_NOTICE: 'false',
      AI_MEMORY: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const ok2 = await until(async () => {
      try { const r = await fetch('http://127.0.0.1:' + PORT2 + '/health'); return r.status === 200; } catch { return false; }
    });
    const d2 = await fetch('http://127.0.0.1:' + PORT2 + '/drafts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'whatsapp', to: '5511999998888', body: 'Teste sem WAHA' }),
    });
    const t2 = await fetch('http://127.0.0.1:' + PORT2 + '/tickets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Ticket sem WAHA', status: 'review' }),
    });
    check('safe no-op when ALLOWED_NUMBERS and WAHA_URL are empty', Boolean(ok2 && d2.status === 200 && t2.status === 200), { ok2, d2: d2.status, t2: t2.status });
  } finally {
    b2.kill('SIGTERM');
    fs.rmSync(tmpEmpty, { recursive: true, force: true });
  }

} catch (err) {
  console.error('FAIL exception', err.stack);
  failed++;
} finally {
  bridge.kill('SIGTERM');
  waha.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) console.error(logs.slice(-3000));
console.log(failed ? 'DECISIONS WHATSAPP FAIL (' + failed + ' failed, ' + passed + ' passed)' : 'DECISIONS WHATSAPP OK (' + passed + ' passed)');
process.exit(failed ? 1 : 0);
