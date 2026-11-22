// Integration tests for GitHub Copilot CLI provider (@github/copilot):
// - /admin/providers lists copilot with version, auth, and models
// - Web chat with provider=copilot runs copilot -p --output-format json, parses JSONL, captures sessionId, and resumes via --resume
// - WhatsApp /provider copilot + /model gpt-5.3-codex works
// - Automatic failover from failed provider into copilot
// - Multi-model /council includes copilot
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dir = path.dirname(new URL(import.meta.url).pathname);
const bridgePath = path.join(dir, '..', 'bridge', 'bridge.mjs');
assert.equal(fs.readFileSync(bridgePath, 'utf8').includes('$'), false, 'bridge.mjs must not contain $');

const tmp = path.join(dir, 'tmp-copilot');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
fs.mkdirSync(path.join(tmp, '.copilot'), { recursive: true });

// Seed yesterday's usage in Copilot session-store.db to verify SQLite historical aggregation + non-cache math
const cpDb = new DatabaseSync(path.join(tmp, '.copilot', 'session-store.db'));
cpDb.exec(`
  CREATE TABLE assistant_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_nano_aiu INTEGER,
    request_multiplier REAL,
    duration_ms INTEGER,
    initiator TEXT,
    created_at TEXT
  );
`);
const yesterdayIso = new Date(Date.now() - 86400000).toISOString();
cpDb.prepare('INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, request_multiplier, duration_ms, initiator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run('cp-prev-sess', 'gpt-6-luna', 1500, 40, 500, 900, 10, 500000000, 1.0, 250, 'user', yesterdayIso);
cpDb.close();

// Fake GitHub Copilot CLI binary emitting real JSONL schema (usage_record + usage_checkpoint + shutdown with cache_write)
const fakeCopilot = path.join(tmp, 'copilot.mjs');
fs.writeFileSync(fakeCopilot, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('GitHub Copilot CLI 1.0.114.'); process.exit(0); }
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : '';
const p = get('-p');
const model = get('--model') || 'mai-code-2-flash';
const resume = get('--resume');
const effort = get('--reasoning-effort');
const sid = resume || 'cp-sess-999';
console.log(JSON.stringify({ type: 'session.start', data: { sessionId: sid } }));
console.log(JSON.stringify({ type: 'assistant.message', data: { model, content: 'COPILOT_OK|m=' + model + '|r=' + (resume ? '1' : '0') + '|e=' + effort + '|p=' + p.slice(-40) } }));
console.log(JSON.stringify({ type: 'session.usage_record', data: { usage: { model, responseModel: model, inputTokens: 600, cacheReadTokens: 100, cacheWriteTokens: 490, outputTokens: 25, reasoningTokens: 5, duration: 120 } } }));
console.log(JSON.stringify({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 1250000000, totalPremiumRequests: 1, accountingSnapshot: { currentModel: model, totalPremiumRequestCost: 1, totalNanoAiu: 1250000000, totalApiDurationMs: 120, tokenDetails: { input: { tokenCount: 10 }, cache_write: { tokenCount: 490 }, cache_read: { tokenCount: 100 }, output: { tokenCount: 25 } } } } }));
console.log(JSON.stringify({ type: 'session.shutdown', data: { totalNanoAiu: 1250000000, totalPremiumRequests: 1, totalApiDurationMs: 120, accountingSnapshot: { currentModel: model, totalPremiumRequestCost: 1, totalNanoAiu: 1250000000, totalApiDurationMs: 120, tokenDetails: { input: { tokenCount: 10 }, cache_write: { tokenCount: 490 }, cache_read: { tokenCount: 100 }, output: { tokenCount: 25 } } }, modelMetrics: { [model]: { usage: { reasoningTokens: 5 } } } } }));
console.log(JSON.stringify({ type: 'result', sessionId: sid, exitCode: 0, usage: { premiumRequests: 1, sessionDurationMs: 180 } }));
`);
fs.chmodSync(fakeCopilot, 0o755);

// Failing Claude binary to test failover -> copilot
const failClaude = path.join(tmp, 'claude-fail.mjs');
fs.writeFileSync(failClaude, `#!/usr/bin/env node
process.stderr.write('claude error 529');
process.exit(1);
`);
fs.chmodSync(failClaude, 0o755);

const wahaSent = [];
const WAHA_PORT = 4095;
const PORT = 4096;
const CP_API_PORT = 4094;
const TOKEN = 'test-copilot-tok';
const waha = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    if (req.url === '/api/sendText') { try { wahaSent.push(JSON.parse(b)); } catch {} }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
}).listen(WAHA_PORT);

const cpApiServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    login: 'test-user',
    access_type_sku: 'free_limited_copilot',
    copilot_plan: 'individual',
    quota_reset_date_utc: '2026-12-01T00:00:00.000Z',
    token_based_billing: true,
    quota_snapshots: {
      chat: { unlimited: false, has_quota: true, percent_remaining: 84.7, credits_used: 30, remaining: 169, entitlement: 200 },
      completions: { unlimited: false, has_quota: true, percent_remaining: 99.9, credits_used: 2, remaining: 1998, entitlement: 2000 },
      premium_interactions: { unlimited: false, has_quota: false, percent_remaining: 0.0, credits_used: 0, remaining: 0, entitlement: 0 },
    },
  }));
}).listen(CP_API_PORT);

const bridge = spawn(process.execPath, [bridgePath], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOME: tmp,
    CLAUDE_WORKDIR: path.join(tmp, 'workspace'),
    WAHA_URL: 'http://127.0.0.1:' + WAHA_PORT,
    WAHA_API_KEY: 'k',
    WAHA_SESSION: 'S',
    ALLOWED_NUMBERS: '5511999990000',
    CLAUDE_BIN: failClaude,
    AGY_BIN: path.join(tmp, 'no-agy'),
    OPENCODE_BIN: path.join(tmp, 'no-oc'),
    COPILOT_BIN: fakeCopilot,
    COPILOT_GITHUB_TOKEN: 'gho_test_token',
    COPILOT_USAGE_URL: 'http://127.0.0.1:' + CP_API_PORT + '/copilot_internal/user',
    BRIDGE_ADMIN_TOKEN: TOKEN,
    STARTUP_NOTICE: 'false',
    AI_MEMORY_AUTO: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const api = async (method, p, body) => {
  const r = await fetch('http://127.0.0.1:' + PORT + p, {
    method,
    headers: {
      ...(p.startsWith('/admin') ? { Authorization: 'Bearer ' + TOKEN } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let parsed = txt; try { parsed = JSON.parse(txt); } catch {}
  return { status: r.status, body: parsed };
};
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
};

let okCount = 0;
const check = (name, cond, detail) => {
  if (!cond) { console.error('FAIL:', name, detail || ''); process.exitCode = 1; throw new Error(name); }
  okCount++; console.log('PASS:', name);
};

try {
  const ready = await until(async () => { try { return (await api('GET', '/health')).body.ok; } catch { return false; } });
  check('bridge healthy', ready);

  // 1. /admin/providers lists copilot
  const provs = (await api('GET', '/admin/providers')).body;
  const cp = provs.providers.find((x) => x.id === 'copilot');
  check('providers lists GitHub Copilot installed with version and models', cp && cp.installed && cp.version.includes('1.0.114') && cp.models.length >= 5, cp);

  // 2. Web chat turn 1 + turn 2 (resumes session via --resume!)
  const ch = (await api('POST', '/admin/web', { title: 'Copilot Web', provider: 'copilot', model: 'gpt-5.3-codex', effort: 'high' })).body;
  const hex = ch.id.slice(4);
  await api('POST', '/admin/web/' + hex + '/messages', { text: 'primeira pergunta' });
  const m1 = await until(async () => ((await api('GET', '/admin/web/' + hex + '/messages')).body.messages || []).find((m) => m.role === 'assistant'));
  check('copilot web turn 1 uses model & effort and parses JSONL', m1 && !m1.error && m1.provider === 'copilot' && m1.text.includes('COPILOT_OK|m=gpt-5.3-codex|r=0|e=high'), m1);

  await api('POST', '/admin/web/' + hex + '/messages', { text: 'segunda pergunta' });
  const m2 = await until(async () => ((await api('GET', '/admin/web/' + hex + '/messages')).body.messages || []).filter((m) => m.role === 'assistant')[1]);
  check('copilot web turn 2 resumes session (--resume)', m2 && !m2.error && m2.text.includes('|r=1|'), m2);

  // 3. WhatsApp /provider copilot + message
  await api('POST', '/webhook', { event: 'message', session: 'S', payload: { id: 'w1', from: '5511999990000@c.us', body: '/provider copilot', fromMe: false } });
  const wSwitch = await until(() => wahaSent.find((x) => x.text && x.text.includes('GitHub Copilot')));
  check('WhatsApp /provider copilot switches provider', Boolean(wSwitch), wSwitch);

  await api('POST', '/webhook', { event: 'message', session: 'S', payload: { id: 'w2', from: '5511999990000@c.us', body: 'oi copilot zap', fromMe: false } });
  const wReply = await until(() => wahaSent.find((x) => x.text && x.text.includes('COPILOT_OK')));
  check('WhatsApp chat responds via GitHub Copilot CLI', Boolean(wReply), wReply);

  // 4. Failover from broken Claude into Copilot!
  await api('PUT', '/admin/settings', { defaultProvider: 'claude', routing: { enabled: true, fallbackOrder: ['claude', 'copilot'] } });
  const chFo = (await api('POST', '/admin/web', { title: 'Failover to Copilot' })).body;
  const hexFo = chFo.id.slice(4);
  await api('POST', '/admin/web/' + hexFo + '/messages', { text: 'teste failover' });
  const mFo = await until(async () => ((await api('GET', '/admin/web/' + hexFo + '/messages')).body.messages || []).find((m) => m.role === 'assistant'));
  check('automatic failover claude -> copilot works', mFo && !mFo.error && mFo.provider === 'copilot' && mFo.meta && mFo.meta.fallbackFrom === 'claude', mFo);

  // 5. Council with Copilot
  const cn = (await api('POST', '/admin/council', { prompt: 'Testar copilot no conselho', providers: ['copilot'] })).body;
  check('council runs GitHub Copilot cleanly', cn && cn.opinions && cn.opinions.length === 1 && cn.opinions[0].text.includes('COPILOT_OK'), cn);

  // 6. Usage report: Copilot quotas, cache_write accounting, AIU credits, and SQLite yesterday history
  const usage = (await api('GET', '/admin/usage?days=14')).body;
  const chatQ = usage.copilot && Array.isArray(usage.copilot.quotas) && usage.copilot.quotas.find((q) => q.id === 'chat');
  const compQ = usage.copilot && Array.isArray(usage.copilot.quotas) && usage.copilot.quotas.find((q) => q.id === 'completions');
  check('usage returns copilot plan and quotas', usage.copilot && usage.copilot.planLabel === 'Free' && chatQ && chatQ.percent === 15.3 && chatQ.used === 30 && chatQ.entitlement === 200 && compQ && compQ.percent === 0.1, usage.copilot);
  check('usage copilot aggregates non-cache tokens (incl. cache_write + DB) and AIU credits without USD cost', usage.providers && usage.providers.copilot && usage.providers.copilot.tokens >= 1580 && usage.providers.copilot.credits > 0 && usage.providers.copilot.telemetry.cost === false && usage.providers.copilot.telemetry.credits === true, usage.providers && usage.providers.copilot);
  const yest = usage.days && usage.days.at(-2);
  check('usage includes yesterday copilot data from session-store.db', Boolean(yest && yest.copilot && yest.copilot.tokens >= 1050 && yest.copilot.credits > 0), yest);

  console.log('\nALL ' + okCount + ' COPILOT TESTS PASSED!');
} finally {
  bridge.kill('SIGTERM');
  waha.close();
  cpApiServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
