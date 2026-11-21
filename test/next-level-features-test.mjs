// Comprehensive integration tests for Next-Level Features (Fase 2A + 2B):
// - Zero '$' invariant in bridge.mjs
// - Smart Model Router + Automatic Failover + /council
// - Web Chat slash commands parity (/status, /new, /provider, /bot, /council)
// - Interactive Mini-Apps: Persistent Page Data (/pages/:id/data, /admin/pages/:id/data, /p/:id/:token/data + window.PageData injection)
// - Global Unified Search (chats, tickets, pages, skills, bots, memory, Obsidian vault)
// - Action Inbox + Assisted Drafts (create, patch, send, schedule)
// - iOS Shortcuts / Share Sheet Bearer auth + ticket/note/draft/chat ingest
// - Chat Fork (branch conversation from message index)
// - Workspace Git Undo Checkpoints (snapshot + restore)
// - Guest / Family isolated WhatsApp bot access
// - Multi-Step Workflows (bot -> condition -> approval -> page_data + resume from prompt + Morning Briefing preset)
// - 1-Click Behavior Correction (provenance feedback -> bot MEMORY.md)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const bridgePath = path.join(dir, '..', 'bridge', 'bridge.mjs');
const bridgeSrc = fs.readFileSync(bridgePath, 'utf8');
assert.equal(bridgeSrc.includes('$'), false, 'bridge.mjs MUST NOT contain dollar sign ($)');

const tmp = path.join(dir, 'tmp-nextlevel');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'workspace', 'demo-repo'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'personal-vault', 'Projetos'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'personal-vault', 'Projetos', 'foguete.md'), '# Projeto Foguete\nMotor quantico supersecreto.\n');

// Initialize a small git repo inside tmp/workspace/demo-repo for Workspace Undo tests
const demoRepo = path.join(tmp, 'workspace', 'demo-repo');
execSync('git init -q && git config user.email t@t.com && git config user.name T', { cwd: demoRepo });
fs.writeFileSync(path.join(demoRepo, 'app.txt'), 'versao-1\n');
execSync('git add . && git commit -qm init', { cwd: demoRepo });

// Fake Claude binary: fails when prompt contains FAIL_CLAUDE (to test failover), otherwise responds nicely
const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : '';
const p = a.includes('--input-format')
  ? await new Promise((res) => {
      let b = '';
      process.stdin.on('data', (d) => {
        b += d;
        const i = b.indexOf('\\n');
        if (i >= 0) {
          process.stdin.destroy();
          try { res(JSON.parse(b.slice(0, i)).message.content.map((x) => x.text || '').join('')); } catch { res(''); }
        }
      });
      process.stdin.on('end', () => res(''));
    })
  : get('-p');
if (p.includes('FAIL_CLAUDE')) {
  process.stderr.write('simulated rate limit 429');
  process.exit(1);
}
console.log(JSON.stringify({
  type: 'result',
  result: 'CLAUDE_OK:' + p.slice(-80),
  session_id: 'cl-sess-1',
  total_cost_usd: 0.01,
  duration_ms: 40,
  num_turns: 1,
}));
`);
fs.chmodSync(fakeClaude, 0o755);

// Fake OpenCode binary (fallback & council partner)
const fakeOc = path.join(tmp, 'opencode.mjs');
fs.writeFileSync(fakeOc, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'models') { console.log('opencode/deepseek-v4.1-flash-free'); process.exit(0); }
const prompt = a[a.length - 1] || '';
console.log(JSON.stringify({ type: 'text', sessionID: 'oc-1', part: { text: 'OC_OK:' + prompt.slice(-60) } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: 'oc-1', part: { cost: 0, tokens: { input: 100, output: 20 } } }));
`);
fs.chmodSync(fakeOc, 0o755);

// Mock WAHA server
const wahaSent = [];
const WAHA_PORT = 4091;
const PORT = 4092;
const TOKEN = 'test-nextlevel-token';
const waha = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url.startsWith('/api/contacts/check-exists')) {
      const u = new URL(req.url, 'http://local');
      const phone = u.searchParams.get('phone');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ numberExists: true, chatId: phone + '@c.us' }));
    }
    if (req.url === '/api/sendText') {
      try { wahaSent.push(JSON.parse(b)); } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
}).listen(WAHA_PORT);

const bridge = spawn(process.execPath, [bridgePath], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOME: tmp,
    CLAUDE_WORKDIR: path.join(tmp, 'workspace'),
    OBSIDIAN_DIR: path.join(tmp, 'personal-vault'),
    WAHA_URL: 'http://127.0.0.1:' + WAHA_PORT,
    WAHA_API_KEY: 'k',
    WAHA_SESSION: 'S',
    ALLOWED_NUMBERS: '5511999990000',
    CLAUDE_BIN: fakeClaude,
    AGY_BIN: path.join(tmp, 'no-agy'),
    OPENCODE_BIN: fakeOc,
    BRIDGE_ADMIN_TOKEN: TOKEN,
    STARTUP_NOTICE: 'false',
    SCHEDULER_TICK_MS: '500',
    AI_MEMORY_AUTO: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let bridgeLogs = '';
bridge.stdout.on('data', (d) => { bridgeLogs += d; });
bridge.stderr.on('data', (d) => { bridgeLogs += d; });

const api = async (method, p, body, extraHeaders = {}) => {
  const r = await fetch('http://127.0.0.1:' + PORT + p, {
    method,
    headers: {
      ...(p.startsWith('/admin') ? { Authorization: 'Bearer ' + TOKEN } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let parsed = txt;
  try { parsed = JSON.parse(txt); } catch {}
  return { status: r.status, body: parsed, text: txt };
};

const until = async (fn, ms = 12000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
};

let passed = 0;
const check = (name, cond, detail) => {
  if (!cond) {
    console.error('FAIL:', name, detail || '');
    console.error('BRIDGE LOGS:\n', bridgeLogs.slice(-2000));
    process.exitCode = 1;
    throw new Error('Failed: ' + name);
  }
  passed++;
  console.log('PASS:', name);
};

try {
  const ready = await until(async () => {
    try { const r = await api('GET', '/health'); return r.status === 200 && r.body.ok; } catch { return false; }
  }, 10000);
  check('bridge started healthy', ready);

  // 1. Smart Model Router + Failover (Claude fails -> automatic fallback to OpenCode!)
  await api('PUT', '/admin/settings', {
    defaultProvider: 'claude',
    routing: { enabled: true, fallbackOrder: ['claude', 'opencode'], lightRouting: false },
  });
  const ch = (await api('POST', '/admin/web', { title: 'Failover Test' })).body;
  const chHex = ch.id.slice(4);
  await api('POST', '/admin/web/' + chHex + '/messages', { text: 'por favor teste FAIL_CLAUDE agora' });
  const foMsg = await until(async () => {
    const ms = (await api('GET', '/admin/web/' + chHex + '/messages')).body.messages || [];
    return ms.find((m) => m.role === 'assistant');
  });
  check('automatic provider failover claude -> opencode', foMsg && !foMsg.error && foMsg.provider === 'opencode' && foMsg.meta && foMsg.meta.fallbackFrom === 'claude' && foMsg.text.includes('OC_OK'), foMsg);

  // 2. Web Chat Slash Commands (/status, /provider, /new)
  await api('POST', '/admin/web/' + chHex + '/messages', { text: '/status' });
  const statusMsg = await until(async () => {
    const ms = (await api('GET', '/admin/web/' + chHex + '/messages')).body.messages || [];
    return ms.find((m) => m.role === 'assistant' && m.text.includes('### Status'));
  });
  check('web chat /status command works natively', Boolean(statusMsg), statusMsg);

  // 3. Multi-Model Council (POST /admin/council)
  const councilRes = await api('POST', '/admin/council', { prompt: 'Qual banco escolher: SQLite ou Postgres?', providers: ['claude', 'opencode'] });
  check('council runs 2 providers in parallel and synthesizes', councilRes.status === 200 && councilRes.body.opinions.length === 2 && councilRes.body.synthesis.length > 0, councilRes.body);

  // 4. Interactive Mini-Apps: Persistent Page Data + window.PageData injection + public /p/:id/:token/data
  const pg = (await api('POST', '/admin/pages', { title: 'Lista Compras', html: '<html><head></head><body><h1>Lista</h1></body></html>', public: true })).body;
  const rawHtml = (await api('GET', '/admin/pages/' + pg.id + '/raw')).text;
  check('admin page raw injects window.PageData helper', rawHtml.includes('window.PageData') && rawHtml.includes('/api/bridge/pages/' + pg.id + '/data'));
  const pubPut = await api('PUT', '/p/' + pg.id + '/' + pg.shareToken + '/data', { items: ['café', 'pão'] });
  check('public mini-app PUT /p/:id/:token/data persists', pubPut.status === 200 && pubPut.body.items.length === 2, pubPut);
  const pubPatch = await api('PATCH', '/p/' + pg.id + '/' + pg.shareToken + '/data', { done: true });
  check('public mini-app PATCH merges data', pubPatch.status === 200 && pubPatch.body.done === true && pubPatch.body.items.length === 2, pubPatch);
  const badPub = await api('GET', '/p/' + pg.id + '/wrong-token/data');
  check('public mini-app rejects invalid share token', badPub.status === 404);
  const localData = await api('GET', '/pages/' + pg.id + '/data');
  check('local agent GET /pages/:id/data reads same state', localData.status === 200 && localData.body.done === true);

  // 5. Assisted Drafts Queue + Send + Action Inbox
  const dr = (await api('POST', '/drafts', { channel: 'whatsapp', to: '5511988887777', body: 'Oi, aviso importante!' })).body;
  check('local bot creates WhatsApp draft', dr && dr.id && dr.status === 'draft', dr);
  const drPatched = (await api('PATCH', '/admin/drafts/' + dr.id, { body: 'Oi, aviso revisado!' })).body;
  check('panel patches draft body', drPatched.body === 'Oi, aviso revisado!');
  const inboxBefore = (await api('GET', '/admin/inbox')).body;
  check('Action Inbox includes pending draft', inboxBefore.total >= 1 && inboxBefore.drafts.some((x) => x.id === dr.id), inboxBefore);
  const drSent = (await api('POST', '/admin/drafts/' + dr.id + '/send')).body;
  check('panel sends draft via WhatsApp', drSent.status === 'sent' && wahaSent.some((m) => m.text.includes('aviso revisado')), { drSent, wahaSent });

  // 6. Global Unified Search (chats, pages, obsidian vault)
  const srchVault = (await api('GET', '/admin/search?q=quantico')).body;
  check('Global Search finds Obsidian vault note', srchVault.groups.obsidian.length === 1 && srchVault.groups.obsidian[0].title === 'foguete', srchVault);
  const srchPage = (await api('GET', '/admin/search?q=Compras')).body;
  check('Global Search finds Page', srchPage.groups.pages.length >= 1 && srchPage.groups.pages[0].id === pg.id, srchPage);

  // 7. iOS Shortcuts / Share Sheet / Siri Endpoint (Bearer token auth)
  const noAuthSc = await api('POST', '/shortcut/ingest', { action: 'ticket', title: 'Sem auth' });
  check('iOS Shortcut rejects missing token', noAuthSc.status === 401);
  const scTok = (await api('POST', '/admin/shortcuts/token')).body;
  check('generates shortcut Bearer token', scTok.token && scTok.token.startsWith('ac_sc_'));
  const scTicket = await api('POST', '/shortcut/ingest', { action: 'ticket', title: 'Comprar leite via Siri', priority: 'high' }, { Authorization: 'Bearer ' + scTok.token });
  check('iOS Shortcut creates Board ticket with spoken reply', scTicket.status === 200 && scTicket.body.ok && scTicket.body.spoken.includes('Comprar leite'), scTicket);
  const scNote = await api('POST', '/shortcut/ingest', { action: 'note', title: 'Ideia Siri', text: 'Testar Share Sheet' }, { Authorization: 'Bearer ' + scTok.token });
  check('iOS Shortcut saves note into Obsidian Inbox', scNote.status === 200 && fs.existsSync(scNote.body.file), scNote);

  // 8. Chat Fork
  const msgsBefore = (await api('GET', '/admin/web/' + chHex + '/messages')).body.messages;
  const forked = (await api('POST', '/admin/web/' + chHex + '/fork', { upToMessageId: msgsBefore[1].id, title: 'Ramo Alternativo', provider: 'claude' })).body;
  check('Chat Fork branches conversation up to chosen message', forked.chat && forked.chat.id !== ch.id && forked.messages.length === 2, forked);

  // 9. Workspace Git Undo Checkpoints
  fs.writeFileSync(path.join(demoRepo, 'app.txt'), 'versao-2-boa\n');
  const cp = (await api('POST', '/admin/undo/snapshot', { repo: 'demo-repo', label: 'Antes do refactor' })).body;
  check('Workspace Undo creates git snapshot', cp && cp.id && cp.dirty === true, cp);
  fs.writeFileSync(path.join(demoRepo, 'app.txt'), 'versao-3-quebrada\n');
  const rest = (await api('POST', '/admin/undo/' + cp.id + '/restore')).body;
  check('Workspace Undo restores tracked file cleanly', rest.ok && fs.readFileSync(path.join(demoRepo, 'app.txt'), 'utf8') === 'versao-2-boa\n');

  // 10. Guest / Family isolated WhatsApp access
  const famBot = (await api('POST', '/admin/bots', { name: 'FamiliaTest', description: 'Casa e compras' })).body;
  await api('PUT', '/admin/settings', {
    guestAccess: [{ name: 'Bia', number: '5511977776666', bot: famBot.id, readOnly: true, enabled: true }],
  });
  await api('POST', '/webhook', { event: 'message', session: 'S', payload: { id: 'gm1', from: '5511977776666@c.us', body: 'oi familia', fromMe: false } });
  const guestReply = await until(() => wahaSent.find((m) => m.chatId === '5511977776666@c.us'));
  check('Guest WhatsApp user gets isolated bot response', Boolean(guestReply), guestReply);
  // Unauthorized number still ignored
  const beforeCount = wahaSent.length;
  await api('POST', '/webhook', { event: 'message', session: 'S', payload: { id: 'gm2', from: '5511911112222@c.us', body: 'invasor', fromMe: false } });
  await new Promise((r) => setTimeout(r, 400));
  check('Non-guest unknown number stays ignored', wahaSent.length === beforeCount);

  // 11. Multi-Step Workflows (bot -> condition -> approval -> page_data + auto-resume on approval!)
  const wf = (await api('POST', '/admin/workflows', {
    name: 'Pipeline Teste',
    chatId: ch.id,
    steps: [
      { id: 's1', name: 'Analisar', type: 'bot', bot: 'default', prompt: 'Analise {{trigger}}' },
      { id: 's2', name: 'Checar', type: 'condition', expr: '{{steps.s1}} contains CLAUDE_OK' },
      { id: 's3', name: 'Aprovar', type: 'approval', title: 'Publicar?', question: 'Aprovar resultado?', options: ['Aprovar', 'Cancelar'] },
      { id: 's4', name: 'SalvarMiniApp', type: 'page_data', pageId: pg.id, patch: { wfResult: '{{steps.s1}}' } },
    ],
  })).body;
  const run1 = (await api('POST', '/admin/workflows/' + wf.id + '/run', { trigger: 'fatura-123' })).body;
  check('Workflow pauses cleanly at approval step', run1.status === 'waiting_approval' && Boolean(run1.pendingPromptId), run1);
  // Answer approval prompt -> workflow must automatically resume and update page data!
  await api('POST', '/admin/prompts/' + run1.pendingPromptId + '/answer', { answer: 'Aprovar' });
  const wfDone = await until(async () => {
    const runs = (await api('GET', '/admin/workflows/runs')).body;
    const found = runs.find((r) => r.id === run1.id);
    return found && found.status === 'done' ? found : null;
  });
  const pgDataAfterWf = (await api('GET', '/admin/pages/' + pg.id + '/data')).body;
  check('Workflow auto-resumes after approval and writes Mini-App data', Boolean(wfDone) && String(pgDataAfterWf.wfResult || '').includes('CLAUDE_OK'), { wfDone, pgDataAfterWf });

  // 12. Morning Briefing 1-Click Preset
  const mb = (await api('POST', '/admin/workflows/preset/morning-briefing', { chatId: ch.id, withAudio: false })).body;
  check('Morning Briefing preset creates live page + daily schedule', mb.page && mb.page.id === 'briefing-diario' && mb.schedule && mb.schedule.cron === '30 7 * * *', mb);

  // 13. 1-Click Behavior Correction (feedback -> bot MEMORY.md)
  const corr = (await api('POST', '/admin/feedback/correct', { chatId: ch.id, messageId: foMsg.id, botId: famBot.id, correction: 'Sempre usar lista com emojis' })).body;
  const botMem = (await api('GET', '/admin/bots/' + famBot.id + '/memory')).body;
  check('1-Click Behavior Correction saves rule into bot MEMORY.md', corr.ok && botMem.content.includes('Sempre usar lista com emojis'), { corr, botMem });

  console.log('\nALL ' + passed + ' NEXT-LEVEL FEATURE TESTS PASSED!');
} finally {
  bridge.kill('SIGTERM');
  waha.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
