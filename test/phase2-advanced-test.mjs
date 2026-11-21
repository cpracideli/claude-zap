// End-to-end test of Phase 2 advanced features:
// SQLite WAL persistence, 3rd BYOM provider (openai_compat with real tool calling + policy enforcement),
// per-bot sandbox guard, Slack webhook (HMAC + url_verification + interactions), Local Computer Bridge WebSocket RPC,
// and Composio / OAuth connectors in encrypted vault.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(dir, 'tmp-phase2'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
const PORT = 4082, MOCK_API_PORT = 4083, TOKEN = 'tok-phase2';
const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `if (process.argv[2] === '--version') { console.log('9.9.9'); process.exit(0); } console.log(JSON.stringify({ type: 'result', result: 'CLAUDE_OK', session_id: 's1', is_error: false, num_turns: 1, duration_ms: 10, total_cost_usd: 0 }));`);

// Mock OpenAI-compatible server that issues one tool call (read_file) then returns final answer
fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'workspace', 'hello.txt'), 'CONTEUDO_DO_ARQUIVO_BYOM');
const mockOpenAi = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const msgs = j.messages || [];
    const hasToolRes = msgs.some((m) => m.role === 'tool');
    res.setHeader('Content-Type', 'application/json');
    if (!hasToolRes) {
      return res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: 'hello.txt' }) } }] } }],
        usage: { prompt_tokens: 40, completion_tokens: 12 },
      }));
    }
    const toolOut = msgs.find((m) => m.role === 'tool')?.content || '';
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'BYOM_FINAL:' + toolOut } }],
      usage: { prompt_tokens: 60, completion_tokens: 20 },
    }));
  });
}).listen(MOCK_API_PORT);

fs.mkdirSync(path.join(tmp, '.bridge'));
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: {
    ...process.env, PORT: String(PORT), HOME: tmp, CLAUDE_WORKDIR: path.join(tmp, 'workspace'),
    CLAUDE_BIN: fakeClaude, AGY_BIN: path.join(tmp, 'no-agy'), BRIDGE_ADMIN_TOKEN: TOKEN,
    ALLOWED_NUMBERS: '5511999990000', STARTUP_NOTICE: 'false', AI_MEMORY: 'off', VAULT_KEY: 'phase2-key-999',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = ''; bridge.stdout.on('data', (d) => { logs += d; }); bridge.stderr.on('data', (d) => { logs += d; });

const base = 'http://127.0.0.1:' + PORT;
const api = async (method, p, body) => {
  const r = await fetch(base + '/admin' + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
};
const local = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
};
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(extra))); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } return null; };

try {
  await wait(800);

  // 1) SQLite WAL persistence active
  const ov = (await api('GET', '/overview')).body;
  check('SQLite WAL storage engine active', ov.storage?.engine === 'sqlite-wal' && fs.existsSync(path.join(tmp, '.bridge', 'state.db')), ov.storage);

  // 2) 3rd BYOM Provider (openai_compat) with real tool calling
  let r = await api('PUT', '/settings', { openaiCompat: { enabled: true, baseUrl: 'http://127.0.0.1:' + MOCK_API_PORT + '/v1', defaultModel: 'mock-gpt', apiKey: 'sk-mock-12345', models: ['mock-gpt', 'llama3.3'] } });
  check('openai_compat configured and API key stored in vault', r.status === 200 && r.body.openaiCompat?.enabled === true && r.body.openaiCompat?.hasKey === true, r.body.openaiCompat);
  const provs = (await api('GET', '/providers')).body.providers;
  check('providers list exposes openai_compat', provs.some((p) => p.id === 'openai_compat' && p.installed === true && p.models.length === 2), provs);

  const c = (await api('POST', '/web', { title: 'BYOM Test', provider: 'openai_compat', model: 'mock-gpt' })).body;
  await api('POST', '/web/' + c.id.slice(4) + '/messages', { text: 'Leia o arquivo hello.txt' });
  const byomAns = await until(async () => {
    const ms = (await api('GET', '/web/' + c.id.slice(4) + '/messages')).body.messages;
    return ms.find((m) => m.role === 'assistant');
  });
  check('openai_compat executes tool_call and returns final text', Boolean(byomAns && byomAns.text.includes('BYOM_FINAL:CONTEUDO_DO_ARQUIVO_BYOM')), byomAns);

  // 3) Per-bot sandbox guard blocks reading vault files
  const sbBot = (await api('POST', '/bots', { name: 'SandboxBot', sandboxed: true })).body;
  check('bot created with sandboxed:true', sbBot.sandboxed === true, sbBot);
  const sbDeny = await local('POST', '/policy/check', { chatId: c.id, botId: sbBot.id, toolName: 'Read', toolInput: { file_path: '/home/node/.bridge/secrets.json' } });
  check('sandboxed bot blocked from reading secrets.json', sbDeny.body.decision === 'deny' && sbDeny.body.reason.includes('Sandbox'), sbDeny.body);

  // 4) Slack webhook: HMAC verification + url_verification
  const slSecret = 'slack_signing_secret_xyz';
  await api('PUT', '/settings', { slack: { enabled: true, botToken: 'xoxb-test', signingSecret: slSecret, allowedUsers: 'U123' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const challBody = JSON.stringify({ type: 'url_verification', challenge: 'chal_abc_999' });
  const badSig = await fetch(base + '/slack/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': 'v0=bad' }, body: challBody });
  check('slack webhook rejects invalid HMAC signature', badSig.status === 401, badSig.status);
  const goodSig = 'v0=' + crypto.createHmac('sha256', slSecret).update('v0:' + ts + ':' + challBody).digest('hex');
  const okChall = await fetch(base + '/slack/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': goodSig }, body: challBody });
  const okChallJson = await okChall.json();
  check('slack webhook passes HMAC and answers url_verification', okChall.status === 200 && okChallJson.challenge === 'chal_abc_999', okChallJson);

  // 5) Local Computer Bridge WebSocket pairing + RPC + revoke
  const paired = (await api('POST', '/local-bridge/pair', { name: 'MacBook Pro Caio' })).body;
  check('local bridge device paired with token', Boolean(paired.id && paired.token && paired.token.startsWith('lcb_')), paired);
  const agentRes = await fetch(base + '/admin/local-bridge/agent.mjs?token=' + encodeURIComponent(paired.token), { headers: { Authorization: 'Bearer ' + TOKEN } });
  const agentCode = await agentRes.text();
  check('local bridge generates runnable zero-dep agent.mjs', agentRes.status === 200 && agentCode.includes(paired.token) && agentCode.includes('new WebSocket'), agentRes.status);

  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/admin/local-bridge/ws?token=' + encodeURIComponent(paired.token));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', os: 'darwin/24.0', cwd: '/Users/caio' }));
      resolve();
    });
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data || '{}'));
    if (m.type === 'req' && m.action === 'info') {
      ws.send(JSON.stringify({ type: 'res', id: m.id, result: { hostname: 'caio-mbp', platform: 'darwin' } }));
    }
  });
  await wait(200);
  const devs = (await api('GET', '/local-bridge/devices')).body;
  check('local bridge device shows online after WS connect', Boolean(devs.find((d) => d.id === paired.id && d.online === true && d.os === 'darwin/24.0')), devs);
  const rpc = await local('POST', '/local-bridge/call', { deviceId: paired.id, action: 'info' });
  check('local bridge RPC call executes and returns response', rpc.status === 200 && rpc.body.hostname === 'caio-mbp', rpc.body);
  await api('DELETE', '/local-bridge/revoke/' + paired.id);
  await wait(150);
  const devsAfter = (await api('GET', '/local-bridge/devices')).body;
  check('local bridge revoke removes device', devsAfter.length === 0, devsAfter);

  // 6) Connectors: Composio setup + generic OAuth token saved in encrypted vault
  const comp = (await api('POST', '/connectors/composio/setup', { apiKey: 'comp_key_abc123', entityId: 'caio' })).body;
  check('composio setup saves key in vault and enables connector', comp.composio?.enabled === true && comp.composio?.configured === true, comp);
  const oauthSave = (await api('POST', '/connectors/oauth/save', { provider: 'google_workspace', label: 'Google Workspace', accessToken: 'ya29.mock-token-999', account: 'caio@gmail.com' })).body;
  check('generic OAuth token persisted in encrypted vault', oauthSave.name === 'oauth_google_workspace' && oauthSave.encrypted === true, oauthSave);
  const connList = (await api('GET', '/connectors')).body;
  check('connectors list returns composio + oauth connections', connList.composio?.configured === true && connList.oauthConnections.length === 1, connList);

} catch (err) {
  console.log('FAIL exception', err.stack);
  failed++;
}
bridge.kill(); mockOpenAi.close();
if (failed) console.log(logs.slice(-3000));
console.log(failed ? 'PHASE 2 ADVANCED FAIL (' + failed + ')' : 'PHASE 2 ADVANCED OK');
process.exit(failed ? 1 : 0);
