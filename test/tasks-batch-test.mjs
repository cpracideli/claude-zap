// Comprehensive tests for:
// - #940174 Antigravity estimated USD cost + usage.jsonl backfill + settings.agyPricing
// - #891d47 Artifacts bulk delete (all, kind, names) with freedBytes
// - #86e375 Per-user Google profile (name, picture) persistence in /admin/prefs/:user
// - #05d471 Ticket chatId persistence, boot interruption recovery & resume
// - #687231 Board Auto-Executor (priority, defaultBot fallback, maxConcurrent, failure loop guard)
// - #f0c4ad AI bot avatar generation (sync + async) via agy + ffmpeg 256x256 JPEG
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-batch');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const PORT = 4072, WAHA_PORT = 4071, TOKEN = 'tok-batch', W = '5511999990000@c.us';

// Fake Claude binary: fails if prompt includes FAIL_ME, sleeps if SLOW_TICKET
const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
if (a[0] === '--version') { console.log('9.9.9'); process.exit(0); }
const p = get('-p') || '';
if (p.includes('SLOW_TICKET')) await new Promise((r) => setTimeout(r, 1400));
if (p.includes('FAIL_ME')) {
  console.error('simulated failure');
  process.exit(1);
}
console.log(JSON.stringify({ type: 'result', result: 'DONE:' + p.slice(0, 40), session_id: 's-b', is_error: false, num_turns: 1, duration_ms: 20, total_cost_usd: 0.01 }));
process.exit(0);
`);

// Fake Antigravity binary (agy): handles --version, models, normal chat with usage, and avatar image generation
const fakeAgy = path.join(tmp, 'agy.mjs');
fs.writeFileSync(fakeAgy, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
if (a[0] === '--version') { console.log('1.9.0'); process.exit(0); }
if (a[0] === 'models') { console.log('gemini-4-neon-high  Gemini 4 Neon (High)'); process.exit(0); }
const p = get('-p') || '';
if (p.includes('image-generator')) {
  // Minimal valid 1x1 JPEG bytes (ff d8 ff ...)
  const jpgB64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const brainDir = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', 'conv-av-1');
  fs.mkdirSync(brainDir, { recursive: true });
  const imgPath = path.join(brainDir, 'avatar.jpg');
  fs.writeFileSync(imgPath, Buffer.from(jpgB64, 'base64'));
  console.log(JSON.stringify({ status: 'SUCCESS', conversation_id: 'conv-av-1', response: 'Generated at ' + imgPath, duration_seconds: 0.2 }));
  process.exit(0);
}
console.log(JSON.stringify({
  status: 'SUCCESS',
  conversation_id: 'agy-conv-1',
  model: 'gemini-4-neon',
  response: 'AGY_OK:' + p.slice(0, 30),
  duration_seconds: 0.5,
  num_turns: 2,
  usage: { input_tokens: 100000, output_tokens: 20000, thinking_tokens: 5000, cache_read_tokens: 40000 },
}));
process.exit(0);
`);
fs.chmodSync(fakeAgy, 0o755);

const waha = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{"id":"m1"}'); });
}).listen(WAHA_PORT);

// Pre-seed bridge state:
// 1) An in_progress ticket left behind across restart (for #05d471 recovery check)
// 2) A historical usage.jsonl line with provider=antigravity and cost=0 (for #940174 backfill)
const bridgeDir = path.join(tmp, '.bridge');
fs.mkdirSync(bridgeDir, { recursive: true });
fs.writeFileSync(path.join(bridgeDir, 'chats.json'), JSON.stringify({ [W]: {} }));
fs.writeFileSync(path.join(bridgeDir, 'tickets.json'), JSON.stringify([
  {
    id: 'int001',
    title: 'Tarefa interrompida no restart',
    description: 'Estava rodando antes do crash',
    status: 'in_progress',
    priority: 'high',
    bot: 'default',
    goal: false,
    comments: [],
    chatId: 'web:abcdef123456',
    created: new Date(Date.now() - 60000).toISOString(),
    updated: new Date(Date.now() - 60000).toISOString(),
  },
]));
const todayIso = new Date().toISOString();
fs.writeFileSync(path.join(bridgeDir, 'usage.jsonl'), JSON.stringify({
  at: todayIso, provider: 'antigravity', web: true, cost: 0, ms: 500, model: 'gemini-3.8-flash',
  in: 1000000, out: 500000, cacheRead: 0,
}) + '\n');

// Pre-seed inbox artifacts for #891d47
const inboxDir = path.join(tmp, 'workspace', 'inbox');
fs.mkdirSync(inboxDir, { recursive: true });
fs.writeFileSync(path.join(inboxDir, 'sample-pic.png'), Buffer.alloc(4096, 1));
fs.writeFileSync(path.join(inboxDir, 'sample-voice.ogg'), Buffer.alloc(2048, 2));
fs.writeFileSync(path.join(inboxDir, 'sample-doc.pdf'), Buffer.alloc(8192, 3));

const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT), HOME: tmp, CLAUDE_WORKDIR: path.join(tmp, 'workspace'),
    CLAUDE_BIN: fakeClaude, AGY_BIN: fakeAgy, AVATAR_GEN_BIN: fakeAgy,
    BRIDGE_ADMIN_TOKEN: TOKEN, ALLOWED_NUMBERS: '5511999990000',
    WAHA_URL: 'http://127.0.0.1:' + WAHA_PORT, WAHA_SESSION: 'S',
    STARTUP_NOTICE: 'false', AI_MEMORY: 'off', SCHEDULER_TICK_MS: '60000',
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
  return { status: r.status, body: await r.json().catch(() => null) };
};
const local = async (method, p, body) => {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let failed = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra)));
  if (!ok) failed++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(120); }
  return null;
};

try {
  await wait(1000);

  // --- #05d471: Boot interruption recovery & ticket chatId persistence ---
  const tksBoot = (await api('GET', '/tickets')).body;
  const intTk = tksBoot.find((x) => x.id === 'int001');
  check('boot detects in_progress ticket as interrupted with comment', intTk && intTk.interrupted === true && intTk.comments.length === 1 && intTk.comments[0].author === 'Sistema', intTk);

  const createdLocal = (await local('POST', '/tickets', { title: 'Criada no chat', status: 'in_progress', chatId: 'web:112233445566', priority: 'medium' })).body;
  check('POST /tickets persists chatId and status', createdLocal && createdLocal.chatId === 'web:112233445566' && createdLocal.status === 'in_progress', createdLocal);

  // Resume interrupted ticket -> preserves web chatId and finishes cleanly
  const resTk = (await api('POST', '/tickets/int001/resume')).body;
  check('resume clears interrupted and keeps web chatId', resTk && resTk.interrupted === false && resTk.chatId === 'web:abcdef123456', resTk);
  const doneInt = await until(async () => {
    const cur = (await api('GET', '/tickets')).body.find((x) => x.id === 'int001');
    return cur && cur.status === 'review' ? cur : null;
  });
  check('resumed ticket completed to review preserving web chatId', doneInt && doneInt.chatId === 'web:abcdef123456', doneInt);

  // --- #86e375: User profile (name, picture) persisted in /admin/prefs/:user ---
  const pSave = await api('PUT', '/prefs/' + encodeURIComponent('Caio@Example.com'), {
    dock: ['chat', 'bots', 'board'],
    profile: { name: 'Caio Pracideli', picture: 'https://lh3.googleusercontent.com/a/photo123' },
  });
  check('prefs saves profile name and picture alongside dock', pSave.status === 200 && pSave.body.profile?.name === 'Caio Pracideli' && pSave.body.profile?.picture.includes('photo123') && pSave.body.dock?.length === 3, pSave.body);
  const pGet = await api('GET', '/prefs/' + encodeURIComponent('caio@example.com'));
  check('prefs returns persisted profile case-insensitively', pGet.status === 200 && pGet.body.profile?.picture === 'https://lh3.googleusercontent.com/a/photo123', pGet.body);

  // --- #891d47: Artifacts bulk delete (kind, names, all) ---
  const arts0 = (await api('GET', '/artifacts')).body;
  check('artifacts lists all 3 seeded files', arts0.length === 3, arts0.length);
  const delImg = await api('DELETE', '/artifacts?kind=image');
  check('DELETE /artifacts?kind=image deletes only image and returns freedBytes', delImg.status === 200 && delImg.body.deleted === 1 && delImg.body.freedBytes === 4096, delImg.body);
  const delByName = await api('DELETE', '/artifacts', { names: ['sample-doc.pdf'] });
  check('DELETE /artifacts with names deletes target file', delByName.status === 200 && delByName.body.deleted === 1 && delByName.body.freedBytes === 8192, delByName.body);
  const delAll = await api('DELETE', '/artifacts');
  check('DELETE /artifacts deletes remaining files', delAll.status === 200 && delAll.body.deleted === 1 && delAll.body.freedBytes === 2048, delAll.body);
  check('artifacts empty after bulk delete', (await api('GET', '/artifacts')).body.length === 0);

  // --- #940174: Antigravity estimated USD cost + usage.jsonl backfill ---
  const cAgy = (await api('POST', '/web', { title: 'Agy Cost Chat', provider: 'antigravity', agyModel: 'gemini-4-neon' })).body;
  await api('POST', '/web/' + cAgy.id.slice(4) + '/messages', { text: 'teste custo agy' });
  const agyMsg = await until(async () => {
    const ms = (await api('GET', '/web/' + cAgy.id.slice(4) + '/messages')).body.messages;
    return ms.find((m) => m.role === 'assistant');
  });
  // Expected for gemini-4-neon: (100000*2.5 + 25000*15 + 40000*0.625) / 1e6 = (250000 + 375000 + 25000)/1e6 = 0.65
  check('antigravity assistant message carries estimated cost=0.65', agyMsg && agyMsg.usage && Math.abs(agyMsg.usage.cost - 0.65) < 0.001 && agyMsg.usage.estimated === true, agyMsg);
  const usageRep = (await api('GET', '/usage?days=7')).body;
  const todayRow = usageRep.days.at(-1);
  // Historical flash line: (1e6*0.15 + 5e5*0.60)/1e6 = 0.45. Plus 0.65 = 1.10
  check('usage report includes antigravity cost with historical backfill', todayRow && Math.abs(todayRow.antigravity.cost - 1.10) < 0.01, todayRow);
  check('monthly spending summary includes antigravity estimated cost', usageRep.spending && usageRep.spending.monthSpendUsd >= 1.09, usageRep.spending);

  // --- #687231: Board Auto-Executor (priority, defaultBot, maxConcurrent, failure guard) ---
  const botWorker = (await api('POST', '/bots', { name: 'Worker', emoji: '⚙️', description: 'executa fila' })).body;
  const rCfg = await api('PUT', '/tickets/runner', { enabled: true, intervalMin: 5, defaultBot: botWorker.id, maxConcurrent: 1, respectQuietHours: false, onlyAssigned: false });
  check('runner config updated', rCfg.status === 200 && rCfg.body.enabled === true && rCfg.body.defaultBot === botWorker.id && rCfg.body.intervalMin === 5, rCfg.body);

  const tkLow = (await api('POST', '/tickets', { title: 'Baixa prioridade', priority: 'low' })).body;
  const tkUrg = (await api('POST', '/tickets', { title: 'Urgente SLOW_TICKET', priority: 'urgent' })).body;
  const tick1 = await api('POST', '/tickets/runner/tick');
  check('runner picks urgent ticket first and assigns defaultBot', tick1.status === 200 && tick1.body.started === true && tick1.body.ticketId === tkUrg.id && tick1.body.bot === botWorker.id, tick1.body);
  // Immediately tick again while SLOW_TICKET is running -> max_concurrent
  await wait(150);
  const tickBusy = await api('POST', '/tickets/runner/tick');
  check('runner respects maxConcurrent=1 while ticket running', tickBusy.status === 200 && tickBusy.body.started === false && tickBusy.body.reason === 'max_concurrent', tickBusy.body);
  // Wait for SLOW_TICKET to finish
  await until(async () => {
    const cur = (await api('GET', '/tickets')).body.find((x) => x.id === tkUrg.id);
    return cur && cur.status === 'review' ? cur : null;
  });

  // Failure loop protection: FAIL_ME fails twice -> moves to blocked
  const tkFail = (await api('POST', '/tickets', { title: 'Vai falhar FAIL_ME', priority: 'high' })).body;
  await api('POST', '/tickets/runner/tick'); // failure #1 -> back to todo (autoFailCount=1)
  const afterFail1 = await until(async () => {
    const cur = (await api('GET', '/tickets')).body.find((x) => x.id === tkFail.id);
    return cur && cur.autoFailCount === 1 && cur.status === 'todo' ? cur : null;
  });
  check('failure #1 increments autoFailCount and returns to todo for retry', Boolean(afterFail1), afterFail1);
  await api('POST', '/tickets/runner/tick'); // failure #2 -> blocked!
  const afterFail2 = await until(async () => {
    const cur = (await api('GET', '/tickets')).body.find((x) => x.id === tkFail.id);
    return cur && cur.autoFailCount >= 2 && cur.status === 'blocked' ? cur : null;
  });
  check('failure #2 moves ticket to blocked with auto-executor comment', Boolean(afterFail2 && afterFail2.comments.some((c) => c.author === 'Auto-Executor')), afterFail2);
  // Clean up remaining low ticket check
  check('low priority ticket still waiting in todo', (await api('GET', '/tickets')).body.find((x) => x.id === tkLow.id)?.status === 'todo');

  // --- #f0c4ad: AI Bot Avatar Generation (sync & async) ---
  const avSync = await api('POST', '/bots/generate-avatar', { name: 'Radar', color: '#8e5cf7', description: 'Pesquisa de IA', hint: 'telescópio' });
  check('POST /admin/bots/generate-avatar returns 256x256 JPEG data URI', avSync.status === 200 && typeof avSync.body.avatar === 'string' && avSync.body.avatar.startsWith('data:image/jpeg;base64,') && avSync.body.avatar.length <= 120000, avSync.body ? { status: avSync.status, len: avSync.body.avatar?.length } : avSync);
  const avAsync = await api('POST', '/bots/' + botWorker.id + '/generate-avatar', { async: true, hint: 'engrenagem' });
  check('POST /admin/bots/:id/generate-avatar async returns 202', avAsync.status === 202 && avAsync.body.started === true, avAsync.body);
  const botWithAv = await until(async () => {
    const b = (await api('GET', '/bots')).body.find((x) => x.id === botWorker.id);
    return b && b.avatar && b.avatar.startsWith('data:image/jpeg;base64,') ? b : null;
  }, 10000);
  check('async avatar generation updates bot avatar in background', Boolean(botWithAv), botWithAv && { id: botWithAv.id, len: botWithAv.avatar?.length });

} catch (err) {
  console.log('FAIL exception', err.stack);
  failed++;
}
bridge.kill();
waha.close();
if (failed) console.log(logs.slice(-3000));
console.log(failed ? 'TASKS BATCH FAIL (' + failed + ')' : 'TASKS BATCH OK');
process.exit(failed ? 1 : 0);
