// End-to-end test for Grok Bot / Rakazo parity features:
// Skills (+ /slug expansion), Protected Secrets Vault (+ secret prompt card + exec redaction),
// Bot Templates, Bot Recipe Export & Grok Bot Import, Ticket Board (+ bot execution),
// Live Computer (status, start, control, screenshot, viewer, stop), Artifacts, Chat pin/archive, Activity feed.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import vm from 'node:vm';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-grokbot');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp);
const PORT = 4062, TOKEN = 'tok-grokbot', W = '5511999990000@c.us';
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
if (p.includes('ASK_SECRET')) {
  const r = await fetch('http://127.0.0.1:${PORT}/secrets/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: process.env.WA_CHAT_ID, name: 'stripe_key', label: 'Chave Stripe', reason: 'Necessária para consultar faturas', wait: 20 })
  });
  const j = await r.json();
  extra = ' SECRET_STATUS=' + j.status + ':' + j.answer;
}
console.log(JSON.stringify({ type: 'result', result: 'OK:' + p.slice(0, 120) + extra, session_id: 's1', is_error: false, num_turns: 1, duration_ms: 10, total_cost_usd: 0 }));
process.exit(0);
`);

const waha = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{"id":"m1"}'); });
}).listen(4061);

fs.mkdirSync(path.join(tmp, '.bridge'));
fs.writeFileSync(path.join(tmp, '.bridge', 'chats.json'), JSON.stringify({ [W]: {} }));

const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: {
    ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'),
    BRIDGE_ADMIN_TOKEN: TOKEN, ALLOWED_NUMBERS: '5511999990000', WAHA_URL: 'http://127.0.0.1:4061',
    WAHA_SESSION: 'S', STARTUP_NOTICE: 'false', AI_MEMORY: 'off',
    COMPUTER_DISPLAY: ':98', COMPUTER_VNC_PORT: '5998', COMPUTER_WS_PORT: '6088', COMPUTER_CDP_PORT: '9228',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
bridge.stdout.on('data', (d) => { logs += d; });
bridge.stderr.on('data', (d) => { logs += d; });

const base = 'http://127.0.0.1:' + PORT;
const api = async (method, p, body) => {
  const r = await fetch(base + '/admin' + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const local = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } return null; };

try {
  await wait(800);

  // 1. Skills CRUD + /slug expansion in Web Chat
  let r = await api('POST', '/skills', { name: 'Resumo Executivo', description: 'Gera resumo em 3 bullets', instructions: 'SEMPRE responda em 3 tópicos curtos.' });
  check('skill created via admin API', r.status === 200 && r.body.slug === 'resumo-executivo', r.body);
  const c = (await api('POST', '/web', { title: 'Skill Test Chat' })).body;
  await api('POST', '/web/' + c.id.slice(4) + '/messages', { text: '/resumo-executivo relatório Q4' });
  const skillReply = await until(async () => {
    const ms = (await api('GET', '/web/' + c.id.slice(4) + '/messages?read=0')).body.messages;
    return ms.find((m) => m.role === 'assistant');
  });
  check('/slug expands skill instructions into prompt', skillReply && skillReply.text.includes('SKILL ATIVADA: Resumo Executivo'), skillReply);

  // Local agent creates a skill
  r = await local('POST', '/skills', { name: 'Deploy Seguro', description: 'Checklist de deploy', instructions: 'Rodar testes antes.' });
  check('agent can create skill via local /skills', r.status === 200 && r.body.slug === 'deploy-seguro', r.body);

  // 2. Protected Secrets Vault + secret prompt card + exec redaction
  r = await api('POST', '/secrets', { name: 'demo_token', label: 'Demo API Token', value: 'sk_live_SUPERSECRET9999', kind: 'api_key' });
  check('secret created with masked hint only', r.status === 200 && r.body.hint === '••••9999' && !('value' in r.body), r.body);
  const secList = (await api('GET', '/secrets')).body;
  check('list secrets never returns raw values', secList.length === 1 && !JSON.stringify(secList).includes('SUPERSECRET'), secList);

  const execRes = await local('POST', '/secrets/exec', { name: 'demo_token', envVar: 'MY_TOK', command: 'echo "len=${#MY_TOK} val=$MY_TOK"' });
  check('secrets/exec injects env var and redacts output', execRes.status === 200 && execRes.body.out.includes('len=23') && execRes.body.out.includes('[SEGREDO:demo_token]') && !execRes.body.out.includes('SUPERSECRET'), execRes.body);

  // Secret request flow via prompt card
  const sc = (await api('POST', '/web', { title: 'Secret Prompt Chat' })).body;
  await api('POST', '/web/' + sc.id.slice(4) + '/messages', { text: 'ASK_SECRET agora' });
  const secPrompt = await until(async () => {
    const ch = (await api('GET', '/chats')).body.find((x) => x.id === sc.id);
    return ch && ch.pendingPrompt;
  });
  check('secret request creates secret prompt card', secPrompt && secPrompt.kind === 'secret' && secPrompt.secretName === 'stripe_key', secPrompt);
  await api('POST', '/prompts/' + secPrompt.id + '/answer', { secretValue: 'rk_test_VALUE_XYZ123' });
  const secRep = await until(async () => {
    const ms = (await api('GET', '/web/' + sc.id.slice(4) + '/messages?read=0')).body.messages;
    return ms.find((m) => m.role === 'assistant');
  });
  check('secret saved without leaking value into chat reply', secRep && secRep.text.includes('Salvo no cofre (stripe_key)') && !secRep.text.includes('XYZ123'), secRep);
  const secList2 = (await api('GET', '/secrets')).body;
  check('secret from prompt card persisted in vault', secList2.some((x) => x.name === 'stripe_key' && x.hint === '••••Z123'), secList2);

  // 3. Bot Templates, Export & Grok Bot Import
  const tpls = (await api('GET', '/bots/templates')).body;
  check('templates list available', Array.isArray(tpls) && tpls.length >= 6, tpls?.length);
  const fromTpl = await api('POST', '/bots/from-template', { templateId: 'briefing-matinal', chatId: c.id });
  check('bot created from template with skill and paused routine', fromTpl.status === 200 && fromTpl.body.bot.id && fromTpl.body.skill && fromTpl.body.routine?.paused === true, fromTpl.body);

  const exported = await api('GET', '/bots/' + fromTpl.body.bot.id + '/export');
  check('bot recipe export works', exported.status === 200 && exported.body.format === 'agent-control-bot-export' && exported.body.skills.length >= 1, exported.body);

  const grokExport = JSON.stringify({
    format: 'grok-bot-export',
    name: 'Grok Sales Scout',
    description: 'Pesquisa leads diariamente',
    instructions: 'Busque leads ICP e prepare rascunhos.',
    rules: ['Nunca enviar e-mail sem aprovação'],
    skills: [{ name: 'Qualificar Lead', description: 'Avalia fit', steps: '1. Ver site\n2. Checar LinkedIn' }],
    routines: [{ name: 'Scan matinal', cron: '0 9 * * 1-5', prompt: 'Listar 5 novos leads.' }],
  });
  const imp = await api('POST', '/bots/import', { recipe: grokExport, chatId: c.id });
  check('grok-bot-export imports bot, skill and paused routine', imp.status === 200 && imp.body.bot.name === 'Grok Sales Scout' && imp.body.skills.length === 1 && imp.body.routines.length === 1 && imp.body.routines[0].paused === true, imp.body);

  // 4. Ticket Board (Kanban) + bot autonomous run
  const tkt = await api('POST', '/tickets', { title: 'Analisar logs de erro', description: 'Verifique erros de hoje', priority: 'high', bot: fromTpl.body.bot.id });
  check('ticket created', tkt.status === 200 && tkt.body.status === 'todo' && tkt.body.priority === 'high', tkt.body);
  await api('POST', '/tickets/' + tkt.body.id + '/run');
  const tktDone = await until(async () => {
    const list = (await api('GET', '/tickets')).body;
    const found = list.find((x) => x.id === tkt.body.id);
    return found && found.status === 'review' && found.comments.length >= 1 ? found : null;
  });
  check('ticket bot run executes and posts comment + moves to review', Boolean(tktDone), tktDone);

  // 5. Chat pin/archive + Activity feed + Artifacts
  const pinned = await api('PATCH', '/chats/' + encodeURIComponent(c.id), { pinned: true, archived: false });
  check('chat pin supported', pinned.status === 200 && pinned.body.pinned === true, pinned.body);

  fs.writeFileSync(path.join(tmp, 'workspace', 'inbox', 'web-test-artifact.txt'), 'hello artifact');
  const arts = await api('GET', '/artifacts');
  check('artifacts lists inbox files', arts.status === 200 && arts.body.some((x) => x.name === 'web-test-artifact.txt'), arts.body);
  const artFile = await fetch(base + '/admin/artifacts/file/web-test-artifact.txt', { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('artifact download works', artFile.status === 200 && (await artFile.text()) === 'hello artifact');

  const act = await api('GET', '/activity');
  check('activity feed returns unified items', act.status === 200 && Array.isArray(act.body) && act.body.length > 0, act.body?.slice(0, 3));

  // 6. Live Computer status + viewer HTML + start/control/screenshot/stop
  const cst = await api('GET', '/computer/status');
  check('computer status reports available tools', cst.status === 200 && cst.body.status === 'stopped' && cst.body.available.xvfb && cst.body.available.x11vnc && cst.body.available.websockify, cst.body);
  const viewerRes = await fetch(base + '/admin/computer/viewer', { headers: { Authorization: 'Bearer ' + TOKEN } });
  const viewerHtml = await viewerRes.text();
  check('computer viewer returns RFB HTML', viewerRes.status === 200 && viewerHtml.includes('RFB'));

  const viewerScript = viewerHtml.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1]?.replace(/^\s*import RFB from [^;]+;\s*/, '');
  const viewerElements = new Map();
  const element = (id) => {
    if (!viewerElements.has(id)) {
      const listeners = {};
      viewerElements.set(id, {
        hidden: false, value: '', style: {}, attributes: {}, listeners,
        addEventListener(type, handler) { listeners[type] = handler; },
        setAttribute(name, value) { this.attributes[name] = value; },
        focus() { this.focused = true; },
      });
    }
    return viewerElements.get(id);
  };
  const parentWindow = { sent: [], postMessage(message, origin) { this.sent.push({ message, origin }); } };
  const viewerWindow = { listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; } };
  let viewerRfb = null;
  class TestRfb {
    constructor() { this.listeners = {}; this.sentKeys = []; this.focusCount = 0; this.viewOnly = false; viewerRfb = this; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    focus() { this.focusCount++; }
    sendKey(keysym) { this.sentKeys.push(keysym); }
    clipboardPasteFrom(text) { this.clipboardText = text; }
  }
  const viewerLocation = { protocol: 'http:', host: 'localhost', origin: 'http://localhost' };
  const viewerContext = {
    document: { getElementById: element }, window: viewerWindow, parent: parentWindow,
    location: viewerLocation, RFB: TestRfb, setTimeout() {},
  };
  if (viewerScript) vm.runInNewContext(viewerScript, viewerContext);
  const viewerMessage = (data, source = parentWindow, origin = viewerLocation.origin) => viewerWindow.listeners.message({ data, source, origin });
  check('computer viewer starts read-only with controls hidden', Boolean(viewerScript) && Boolean(viewerRfb) && viewerRfb.viewOnly && element('tools').hidden);
  if (viewerRfb) {
    viewerRfb.listeners.connect();
    viewerMessage({ type: 'viewOnly', value: false }, parentWindow, 'https://untrusted.example');
    const blockedExternalMessage = viewerRfb.viewOnly;
    viewerMessage({ type: 'viewOnly', value: false });
    const focusAfterControl = viewerRfb.focusCount;
    element('screen').listeners.pointerdown();
    element('keyboard-toggle').listeners.click();
    element('text').value = '12é😀';
    element('send-text').listeners.click();
    const sentByMobileKeyboard = viewerRfb.sentKeys.slice();
    const clearedInput = element('text').value === '';
    viewerMessage({ type: 'computer-type', text: 'A\nB' });
    viewerMessage({ type: 'clipboard', text: 'paste' });
    viewerMessage({ type: 'viewOnly', value: true });
    viewerMessage({ type: 'computer-type', text: 'blocked' });
    check('viewer focuses RFB on human control and pointer input', blockedExternalMessage && focusAfterControl === 1 && viewerRfb.focusCount === 2);
    check('viewer mobile text button sends Unicode keysyms and clears field', JSON.stringify(sentByMobileKeyboard) === JSON.stringify([49, 50, 0xe9, 0x0101f600]) && clearedInput);
    check('viewer postMessage typing works only while writable', JSON.stringify(viewerRfb.sentKeys) === JSON.stringify([...sentByMobileKeyboard, 65, 0xff0d, 66]) && viewerRfb.viewOnly && element('tools').hidden);
    check('viewer preserves clipboard message and same-origin connection notice', viewerRfb.clipboardText === 'paste' && parentWindow.sent.some((x) => x.message.type === 'computer-connected' && x.origin === viewerLocation.origin));
  }

  const started = await api('POST', '/computer/start', {});
  check('computer starts cleanly', started.status === 200 && started.body.status === 'running', started.body);
  const ctrl = await api('POST', '/computer/control', { mode: 'human' });
  check('computer takeover switches to human', ctrl.status === 200 && ctrl.body.control === 'human', ctrl.body);
  const shot = await fetch(base + '/admin/computer/screenshot', { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('computer screenshot returns PNG', shot.status === 200 && shot.headers.get('content-type') === 'image/png' && (await shot.arrayBuffer()).byteLength > 100);
  const stopped = await api('POST', '/computer/stop', {});
  check('computer stops cleanly', stopped.status === 200 && stopped.body.status === 'stopped', stopped.body);

  // Overview counts
  const ov = (await api('GET', '/overview')).body;
  check('overview exposes skills, tickets, secrets, computer', ov.skills >= 3 && ov.tickets >= 1 && ov.secrets >= 2 && ov.computer?.status === 'stopped', ov);

  console.log(failed ? 'FAILED: ' + failed : 'GROKBOT PARITY OK');
} finally {
  bridge.kill('SIGTERM');
  waha.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
if (failed) { console.error(logs.slice(-2000)); process.exit(1); }
