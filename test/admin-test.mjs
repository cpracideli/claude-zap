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
const p = get('-p');
const ev = (o) => console.log(JSON.stringify(o));
ev({ type: 'system', subtype: 'init', model: get('--model') || 'default', mcp_servers: [{ name: 'pw', status: 'connected' }] });
ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'vou olhar' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } });
const sys = get('--append-system-prompt') || '';
setTimeout(() => ev({ type: 'result', result: 'ECHO:' + p + ' |web=' + sys.includes('painel web') + ' |resume=' + get('--resume') + ' |model=' + get('--model'), session_id: 'sess-web', is_error: false, num_turns: 2, duration_ms: 900, total_cost_usd: 0.01 }), p === 'slow' ? 4000 : 100);
`);

const PORT = 3999, TOKEN = 'tok-123';
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'), BRIDGE_ADMIN_TOKEN: TOKEN,
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
  const stop = await api('POST', '/chats/' + encodeURIComponent('web:' + id) + '/stop');
  for (let i = 0; i < 40 && sse.events.filter((e) => e.type === 'idle').length < 3; i++) await wait(100);
  const h3 = (await api('GET', '/web/' + id + '/messages')).body.messages.at(-1);
  check('stop', stop.body.stopped && h3.stopped, { stop: stop.body, h3 });

  const patched = await api('PATCH', '/chats/' + encodeURIComponent('web:' + id), { model: 'opus', reset: true });
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

  const del = await api('DELETE', '/chats/' + encodeURIComponent('web:' + id));
  check('delete web chat', del.status === 200 && !(await api('GET', '/schedules')).body.length);
  check('cannot delete whatsapp chat', (await api('DELETE', '/chats/' + encodeURIComponent('5511@c.us'))).status === 400);
  sse.close();
} catch (e) {
  failed++; console.log('ERROR', e);
} finally {
  bridge.kill();
  if (failed) console.log(logs.slice(-3000));
  console.log(failed ? 'ADMIN FAILED ' + failed : 'ADMIN OK');
  process.exit(failed ? 1 : 0);
}
