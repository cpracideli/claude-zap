// Local test of the /admin API used by the Agent Control panel: auth, web chat (SSE), MCP, providers, settings.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-admin'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `
import fs from 'node:fs';
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
const cfgFile = process.env.HOME + '/.claude.json';
const cfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return {}; } };
if (a[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (a[0] === 'mcp') {
  const j = cfg(); j.mcpServers = j.mcpServers || {};
  if (a[1] === 'add-json') { j.mcpServers[a[4]] = JSON.parse(a[5]); fs.writeFileSync(cfgFile, JSON.stringify(j)); console.log('Added ' + a[4]); process.exit(0); }
  if (a[1] === 'remove') { if (!j.mcpServers[a[4]]) { console.error('No MCP server found'); process.exit(1); } delete j.mcpServers[a[4]]; fs.writeFileSync(cfgFile, JSON.stringify(j)); process.exit(0); }
  if (a[1] === 'list') { console.log(Object.keys(j.mcpServers).map((k) => k + ': ok - ✓ Connected').join('\\n')); process.exit(0); }
}
const p = (a.includes('--input-format') ? await new Promise((res) => { let b = ''; process.stdin.on('data', (d) => { b += d; const i = b.indexOf('\\n'); if (i >= 0) { process.stdin.destroy(); try { res(JSON.parse(b.slice(0, i)).message.content.map((x) => x.text || '').join('')); } catch { res(''); } } }); process.stdin.on('end', () => res('')); }) : get('-p')) || '';
const ev = (o) => console.log(JSON.stringify(o));
ev({ type: 'system', subtype: 'init', model: get('--model') || 'default', mcp_servers: [{ name: 'pw', status: 'connected' }] });
ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'vou olhar' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } });
const sys = get('--append-system-prompt') || '';
setTimeout(() => ev({ type: 'result', result: 'ECHO:' + p + ' |web=' + sys.includes('painel web') + ' |resume=' + get('--resume') + ' |model=' + get('--model'), session_id: 'sess-web', is_error: false, num_turns: 2, duration_ms: 900, total_cost_usd: 0.01 }), p.trim().endsWith('slow') ? 4000 : 100);
`);

const PORT = 3999, TOKEN = 'tok-123';
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, '.config'), CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'),
    COPILOT_BIN: path.join(tmp, 'no-copilot'), OPENCODE_BIN: path.join(tmp, 'no-opencode'), BRIDGE_ADMIN_TOKEN: TOKEN,
    ALLOWED_NUMBERS: '5511999990000', WAHA_URL: 'http://127.0.0.1:1', STARTUP_NOTICE: 'false', AI_MEMORY: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; bridge.stdout.on('data', (d) => { logs += d; }); bridge.stderr.on('data', (d) => { logs += d; });
const base = 'http://127.0.0.1:' + PORT + '/admin';
const api = async (method, p, body, token = TOKEN) => {
  const r = await fetch(base + p, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(id) {
  const events = [];
  const req = http.get(base + '/web/' + id + '/events', { headers: { Authorization: 'Bearer ' + TOKEN } }, (res) => {
    let buf = '';
    res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) !== -1) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6))); } });
  });
  return { events, close: () => req.destroy() };
}

try {
  await wait(800);
  check('rejects bad token', (await api('GET', '/overview', null, 'nope')).status === 401);
  const ov = await api('GET', '/overview');
  check('overview', ov.status === 200 && ov.body.version, ov);

  const prov = await api('GET', '/providers');
  check('providers', prov.body.providers[0].version.includes('9.9.9') && prov.body.providers[1].installed === false, prov.body);

  check('settings: bad effort rejected', (await api('PUT', '/settings', { claudeEffort: 'turbo' })).status === 400);
  const st = await api('PUT', '/settings', { claudeEffort: 'high', claudeModel: 'sonnet' });
  check('settings saved', st.body.claudeModel === 'sonnet', st.body);

  const created = await api('POST', '/web', {});
  const id = created.body.id.slice(4);
  check('web chat created', created.body.kind === 'web' && created.body.provider === 'claude', created.body);
  const sse = listen(id);
  await wait(200);
  const sent = await api('POST', '/web/' + id + '/messages', { text: 'oi web' });
  check('message accepted', sent.status === 202, sent);
  for (let i = 0; i < 40 && !sse.events.some((e) => e.type === 'idle'); i++) await wait(100);
  const types = sse.events.map((e) => e.type);
  check('sse events', ['hello', 'message', 'start', 'init', 'text', 'tool', 'tool_result', 'idle'].every((t) => types.includes(t)), types);
  const hist = await api('GET', '/web/' + id + '/messages');
  const last = hist.body.messages.at(-1);
  check('history has answer', hist.body.messages.length === 2 && last.text.includes('ECHO:oi web |web=true') && last.text.includes('model=sonnet') && last.tools[0].result === 'a.txt', hist.body);
  check('title from first message', hist.body.chat.title === 'oi web', hist.body.chat);

  await api('POST', '/web/' + id + '/messages', { text: 'segunda' });
  for (let i = 0; i < 40 && sse.events.filter((e) => e.type === 'idle').length < 2; i++) await wait(100);
  const h2 = (await api('GET', '/web/' + id + '/messages')).body.messages.at(-1);
  check('session resumed', h2.text.includes('resume=sess-web'), h2);

  await api('POST', '/web/' + id + '/messages', { text: 'slow' });
  await wait(600);
  const ovRun = await api('GET', '/overview');
  const runEntry = (ovRun.body.running || []).find((r) => r.chatId === 'web:' + id);
  const webRunEntry = (ovRun.body.webRunning || []).find((r) => r.chatId === 'web:' + id);
  check('overview running includes bot + clean prompt', runEntry && runEntry.bot === 'default' && runEntry.prompt === 'slow' && webRunEntry && webRunEntry.bot === 'default', { runEntry, webRunEntry });
  const stop = await api('POST', '/chats/' + encodeURIComponent('web:' + id) + '/stop');
  for (let i = 0; i < 40 && sse.events.filter((e) => e.type === 'idle').length < 3; i++) await wait(100);
  const h3 = (await api('GET', '/web/' + id + '/messages')).body.messages.at(-1);
  check('stop', stop.body.stopped && h3.stopped, { stop: stop.body, h3 });

  // Secondary bot in web chat + delegation should report its own bot id and clean prompt in /admin/overview
  const secBot = await api('POST', '/bots', { name: 'InfraBot', description: 'DevOps' });
  check('secondary bot created', secBot.status === 200 && secBot.body.id, secBot);
  const secChat = await api('POST', '/web', { bot: secBot.body.id });
  const secId = secChat.body.id.slice(4);
  await api('POST', '/web/' + secId + '/messages', { text: 'slow' });
  await wait(600);
  const ovSec = await api('GET', '/overview');
  const secRun = (ovSec.body.running || []).find((r) => r.chatId === 'web:' + secId);
  const secWebRun = (ovSec.body.webRunning || []).find((r) => r.chatId === 'web:' + secId);
  check('overview running reports secondary bot', secRun && secRun.bot === secBot.body.id && secRun.prompt === 'slow' && secWebRun && secWebRun.bot === secBot.body.id, { secRun, secWebRun });
  await api('POST', '/chats/' + encodeURIComponent('web:' + secId) + '/stop');
  await wait(300);
  const delegAsk = await fetch('http://127.0.0.1:' + PORT + '/bots/' + encodeURIComponent(secBot.body.id) + '/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'web:' + id, question: 'slow', wait: 0 }),
  }).then((r) => r.json());
  await wait(600);
  const ovDeleg = await api('GET', '/overview');
  const delegRun = (ovDeleg.body.running || []).find((r) => r.chatId.startsWith('deleg:'));
  check('overview running reports delegated bot + clean prompt', delegRun && delegRun.bot === secBot.body.id && delegRun.prompt === 'slow' && !String(delegRun.prompt).includes('Pedido do bot'), { delegAsk, delegRun });
  if (delegRun) await api('POST', '/chats/' + encodeURIComponent(delegRun.chatId) + '/stop');
  await wait(200);
  await api('DELETE', '/chats/' + encodeURIComponent('web:' + secId));
  await api('DELETE', '/bots/' + encodeURIComponent(secBot.body.id));

  const patched = await api('PATCH', '/chats/' + encodeURIComponent('web:' + id), { model: 'opus', reset: true });
  // attachments + voice transcript
  const f2 = await api('POST', '/web', {});
  const id2 = f2.body.id.slice(4);
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const up = await api('POST', '/web/' + id2 + '/messages', { text: '', transcript: 'qual o clima', files: [{ name: 'foto 1.png', type: 'image/png', data: png }, { name: 'voz.webm', type: 'audio/webm', data: png, voice: true }] });
  check('attachments accepted', up.status === 202, up);
  await wait(900);
  const h4 = (await api('GET', '/web/' + id2 + '/messages')).body;
  const u4 = h4.messages[0], a4 = h4.messages.at(-1);
  check('attachments saved in history', u4.files.length === 2 && u4.files[0].file.startsWith('web-') && u4.files[1].voice && u4.transcript === 'qual o clima', u4);
  check('agent gets file paths + transcript', a4.text.includes('inbox') && a4.text.includes('mensagem de voz') && a4.text.includes('qual o clima'), a4.text);
  check('title from transcript', h4.chat.title === 'qual o clima', h4.chat);
  const fr = await fetch(base + '/web/files/' + u4.files[0].file, { headers: { Authorization: 'Bearer ' + TOKEN } });
  check('file served', fr.status === 200 && fr.headers.get('content-type') === 'image/png' && (await fr.arrayBuffer()).byteLength === 8);
  check('file path traversal blocked', (await api('GET', '/web/files/' + encodeURIComponent('../web/x.json'))).status === 404);
  check('empty message rejected', (await api('POST', '/web/' + id2 + '/messages', { text: '', files: [] })).status === 400);

  check('patch chat', patched.body.model === 'opus' && !patched.body.session, patched.body);
  check('patch rejects bad provider', (await api('PATCH', '/chats/' + encodeURIComponent('web:' + id), { provider: 'gpt' })).status === 400);
  check('chats list', (await api('GET', '/chats')).body.some((c) => c.id === 'web:' + id));

  const sch = await api('POST', '/schedules', { chatId: 'web:' + id, cron: '0 8 * * *', prompt: 'p', description: 'd' });
  check('schedule add', sch.status === 200 && sch.body.id, sch);
  check('schedule pause', (await api('PATCH', '/schedules/' + sch.body.id, { paused: true })).body.paused === true);

  check('mcp bad name', (await api('POST', '/mcp', { name: 'a b', command: 'x' })).status === 400);
  const add = await api('POST', '/mcp', { name: 'playwright', command: 'npx', args: ['@playwright/mcp@latest', '--headless'] });
  check('mcp add', add.status === 200, add);
  const addHttp = await api('POST', '/mcp', { name: 'remote', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } });
  check('mcp add http', addHttp.status === 200, addHttp);
  const mcp = await api('GET', '/mcp');
  check('mcp list config', mcp.body.claude.user.playwright.args[0] === '@playwright/mcp@latest' && mcp.body.claude.user.remote.type === 'http' && mcp.body.antigravity.installed === false, mcp.body);
  check('mcp status', (await api('GET', '/mcp/status')).body.output.includes('playwright'));
  check('mcp remove', (await api('DELETE', '/mcp/claude/playwright')).status === 200 && !(await api('GET', '/mcp')).body.claude.user.playwright);
  check('mcp remove missing fails', (await api('DELETE', '/mcp/claude/playwright')).status === 400);
  check('audit', (await api('GET', '/audit')).body.some((e) => e.action === 'mcp-add'));

  // Antigravity MCP: config in ~/.gemini/config, real handshake for stdio and HTTP, secrets redacted.
  const agyCfgFile = path.join(tmp, '.gemini', 'config', 'mcp_config.json');
  fs.mkdirSync(path.dirname(agyCfgFile), { recursive: true });
  const goodMcp = path.join(tmp, 'good-mcp.mjs');
  fs.writeFileSync(goodMcp, `process.stdin.on('data', (d) => { const j = JSON.parse(String(d).split('\\n')[0]); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { serverInfo: { name: 'good', version: '1' } } }) + '\\n'); }); setInterval(() => {}, 1000);`);
  const stub = http.createServer((q, s) => { s.writeHead(q.headers.authorization === 'Bearer sekret' ? 200 : 401, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'stub' } } })); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubUrl = 'http://127.0.0.1:' + stub.address().port + '/mcp';
  fs.writeFileSync(agyCfgFile, JSON.stringify({ mcpServers: {
    good: { command: process.execPath, args: [goodMcp], env: { SECRET_ENV: 'abc' } },
    broken: { command: process.execPath, args: ['-e', 'process.exit(3)'] },
    remote: { serverUrl: stubUrl, headers: { Authorization: 'Bearer sekret' } },
    noauth: { serverUrl: stubUrl },
    off: { command: 'x', disabled: true },
  } }));
  const fakeAgy = path.join(tmp, 'no-agy');
  fs.writeFileSync(fakeAgy, `#!/bin/sh\nif [ "$1 $2" = "mcp add" ]; then echo "$@" > ${JSON.stringify(path.join(tmp, 'agy-add-args'))}; echo added; exit 0; fi\necho "NAME STATUS"\n`, { mode: 0o755 });
  const agyList = await api('GET', '/mcp');
  check('agy mcp config path + redaction', agyList.body.antigravity.configPath === agyCfgFile && agyList.body.antigravity.servers.remote.headers.Authorization === '***'
    && agyList.body.antigravity.servers.good.env.SECRET_ENV === '***' && !JSON.stringify(agyList.body).includes('sekret'), agyList.body.antigravity);
  const agyStatus = (await api('GET', '/mcp/status?provider=antigravity')).body;
  check('agy mcp status', agyStatus.servers.good.ok && !agyStatus.servers.broken.ok && agyStatus.servers.remote.ok && !agyStatus.servers.noauth.ok
    && agyStatus.servers.off.disabled && /good: .* - ✔ Connected/.test(agyStatus.output) && !agyStatus.output.includes('sekret'), agyStatus);
  const agyAdd = await api('POST', '/mcp', { provider: 'antigravity', name: 'api', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } });
  check('agy mcp add passes headers', agyAdd.status === 200 && fs.readFileSync(path.join(tmp, 'agy-add-args'), 'utf8').trim() === 'mcp add --header Authorization: Bearer t -- api https://example.com/mcp', agyAdd);
  fs.rmSync(fakeAgy);

  // GitHub Copilot MCP: add/list/redaction/status/remove preserving other keys in ~/.copilot/mcp-config.json
  const fakeCopilot = path.join(tmp, 'no-copilot');
  fs.writeFileSync(fakeCopilot, '#!/bin/sh\necho "GitHub Copilot CLI 1.0.114."\n', { mode: 0o755 });
  const cpCfgFile = path.join(tmp, '.copilot', 'mcp-config.json');
  fs.mkdirSync(path.dirname(cpCfgFile), { recursive: true });
  fs.writeFileSync(cpCfgFile, JSON.stringify({ customMeta: 'keep-me', mcpServers: { offcp: { type: 'local', command: 'x', enabled: false } } }));
  const cpAddStdio = await api('POST', '/mcp', { provider: 'copilot', name: 'goodcp', transport: 'stdio', command: process.execPath, args: [goodMcp], env: { CP_SECRET: 'cp-val-123' } });
  const cpAddHttp = await api('POST', '/mcp', { provider: 'copilot', name: 'remotecp', transport: 'http', url: stubUrl, headers: { Authorization: 'Bearer sekret' } });
  const cpAddNoAuth = await api('POST', '/mcp', { provider: 'copilot', name: 'noauthcp', transport: 'http', url: stubUrl });
  check('copilot mcp add stdio + http', cpAddStdio.status === 200 && cpAddHttp.status === 200 && cpAddNoAuth.status === 200, { cpAddStdio, cpAddHttp, cpAddNoAuth });
  const cpRaw = JSON.parse(fs.readFileSync(cpCfgFile, 'utf8'));
  check('copilot mcp preserves other config keys', cpRaw.customMeta === 'keep-me' && cpRaw.mcpServers.goodcp.type === 'local' && cpRaw.mcpServers.remotecp.type === 'http', cpRaw);
  const cpList = await api('GET', '/mcp');
  check('copilot mcp list + redaction', cpList.body.copilot.installed === true && cpList.body.copilot.configPath === cpCfgFile
    && cpList.body.copilot.servers.goodcp.env.CP_SECRET === '***' && cpList.body.copilot.servers.remotecp.headers.Authorization === '***'
    && !JSON.stringify(cpList.body.copilot).includes('cp-val-123') && !JSON.stringify(cpList.body.copilot).includes('sekret'), cpList.body.copilot);
  const cpStatus = (await api('GET', '/mcp/status?provider=copilot')).body;
  check('copilot mcp status handshake', cpStatus.servers.goodcp.ok && cpStatus.servers.remotecp.ok && !cpStatus.servers.noauthcp.ok && cpStatus.servers.offcp.disabled && !cpStatus.output.includes('sekret'), cpStatus);
  const cpDel = await api('DELETE', '/mcp/copilot/noauthcp');
  check('copilot mcp remove', cpDel.status === 200 && !(await api('GET', '/mcp')).body.copilot.servers.noauthcp && (await api('DELETE', '/mcp/copilot/noauthcp')).status === 400, cpDel);
  fs.rmSync(fakeCopilot);

  // OpenCode MCP: add/list/redaction/status/remove preserving $schema and model in opencode.json
  const fakeOc = path.join(tmp, 'no-opencode');
  fs.writeFileSync(fakeOc, '#!/bin/sh\necho "1.19.6"\n', { mode: 0o755 });
  const ocCfgFile = path.join(tmp, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(ocCfgFile), { recursive: true });
  fs.writeFileSync(ocCfgFile, JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'opencode/nemotron-3.5-lightning-free', mcp: { offoc: { type: 'local', command: ['x'], enabled: false } } }, null, 2));
  const ocAddStdio = await api('POST', '/mcp', { provider: 'opencode', name: 'goodoc', transport: 'stdio', command: process.execPath, args: [goodMcp], env: { OC_SECRET: 'oc-val-456' } });
  const ocAddHttp = await api('POST', '/mcp', { provider: 'opencode', name: 'remoteoc', transport: 'http', url: stubUrl, headers: { Authorization: 'Bearer sekret' } });
  const ocAddNoAuth = await api('POST', '/mcp', { provider: 'opencode', name: 'noauthoc', transport: 'http', url: stubUrl });
  check('opencode mcp add stdio + remote', ocAddStdio.status === 200 && ocAddHttp.status === 200 && ocAddNoAuth.status === 200, { ocAddStdio, ocAddHttp, ocAddNoAuth });
  const ocRaw = JSON.parse(fs.readFileSync(ocCfgFile, 'utf8'));
  check('opencode mcp preserves model + schema + uses mcp.servers', ocRaw.model === 'opencode/nemotron-3.5-lightning-free' && ocRaw.$schema === 'https://opencode.ai/config.json'
    && Array.isArray(ocRaw.mcp.servers.goodoc.command) && ocRaw.mcp.servers.goodoc.environment.OC_SECRET === 'oc-val-456' && ocRaw.mcp.servers.remoteoc.type === 'remote', ocRaw);
  const ocList = await api('GET', '/mcp');
  check('opencode mcp list + redaction', ocList.body.opencode.installed === true && ocList.body.opencode.configPath === ocCfgFile
    && ocList.body.opencode.servers.goodoc.environment.OC_SECRET === '***' && ocList.body.opencode.servers.remoteoc.headers.Authorization === '***'
    && !JSON.stringify(ocList.body.opencode).includes('oc-val-456') && !JSON.stringify(ocList.body.opencode).includes('sekret'), ocList.body.opencode);
  const ocStatus = (await api('GET', '/mcp/status?provider=opencode')).body;
  check('opencode mcp status handshake', ocStatus.servers.goodoc.ok && ocStatus.servers.remoteoc.ok && !ocStatus.servers.noauthoc.ok && ocStatus.servers.offoc.disabled && !ocStatus.output.includes('sekret'), ocStatus);
  const ocDel = await api('DELETE', '/mcp/opencode/noauthoc');
  const ocDelLegacy = await api('DELETE', '/mcp/opencode/offoc');
  check('opencode mcp remove (new + legacy)', ocDel.status === 200 && ocDelLegacy.status === 200 && !(await api('GET', '/mcp')).body.opencode.servers.noauthoc && (await api('DELETE', '/mcp/opencode/noauthoc')).status === 400, { ocDel, ocDelLegacy });
  fs.rmSync(fakeOc);

  stub.close();

  const del = await api('DELETE', '/chats/' + encodeURIComponent('web:' + id));
  check('delete web chat', del.status === 200 && !(await api('GET', '/schedules')).body.length);
  check('cannot delete whatsapp chat', (await api('DELETE', '/chats/' + encodeURIComponent('5511@c.us'))).status === 400);

  // Per-user UI preferences (customizable bottom dock: 1..5 items, 'more' optional).
  const pEmpty = await api('GET', '/prefs/' + encodeURIComponent('caio@example.com'));
  check('prefs default empty', pEmpty.status === 200 && !pEmpty.body.dock, pEmpty);
  const pBadEmpty = await api('PUT', '/prefs/' + encodeURIComponent('caio@example.com'), { dock: [] });
  check('prefs rejects empty dock', pBadEmpty.status === 400, pBadEmpty);
  const pBadTooMany = await api('PUT', '/prefs/' + encodeURIComponent('caio@example.com'), { dock: ['chat', 'bots', 'usage', 'overview', 'logs', 'more'] });
  check('prefs rejects >5 dock', pBadTooMany.status === 400, pBadTooMany);
  const pBadDup = await api('PUT', '/prefs/' + encodeURIComponent('caio@example.com'), { dock: ['chat', 'chat'] });
  check('prefs rejects duplicates', pBadDup.status === 400, pBadDup);
  const pSmall = await api('PUT', '/prefs/' + encodeURIComponent('caio@example.com'), { dock: ['chat', 'bots'] });
  check('prefs allows fewer icons without more', pSmall.status === 200 && JSON.stringify(pSmall.body.dock) === JSON.stringify(['chat', 'bots']), pSmall);
  const pWithMore = await api('PUT', '/prefs/' + encodeURIComponent('caio@example.com'), { dock: ['chat', 'board', 'more'] });
  check('prefs allows more as optional item', pWithMore.status === 200 && JSON.stringify(pWithMore.body.dock) === JSON.stringify(['chat', 'board', 'more']), pWithMore);
  const pRead = await api('GET', '/prefs/' + encodeURIComponent('CAIO@EXAMPLE.COM'));
  check('prefs read case-insensitive', pRead.status === 200 && JSON.stringify(pRead.body.dock) === JSON.stringify(['chat', 'board', 'more']), pRead);
  const pOther = await api('GET', '/prefs/' + encodeURIComponent('other@example.com'));
  check('prefs isolated per user', pOther.status === 200 && !pOther.body.dock, pOther);
  const pReset = await api('PUT', '/prefs/' + encodeURIComponent('caio@example.com'), { dock: null });
  check('prefs restores default', pReset.status === 200 && !pReset.body.dock, pReset);
  sse.close();
} catch (e) {
  failed++; console.log('ERROR', e);
} finally {
  bridge.kill();
  if (failed) console.log(logs.slice(-3000));
  console.log(failed ? 'ADMIN FAILED ' + failed : 'ADMIN OK');
  process.exit(failed ? 1 : 0);
}
