// Local test: fake WAHA + fake claude, then POST webhooks to the bridge.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const tmp = path.join(dir, 'tmp'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
// old-format state to check migration
fs.mkdirSync(path.join(tmp, '.bridge')); fs.writeFileSync(path.join(tmp, '.bridge', 'sessions.json'), JSON.stringify({ '5511999990000@c.us': 'old-sess' }));
const fakeClaude = path.join(tmp, 'claude.mjs');
fs.writeFileSync(fakeClaude, `
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
const p = get('-p');
const out = () => { console.log(JSON.stringify({ type: 'system', subtype: 'init' })); console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })); console.log(JSON.stringify({ type: 'result', result: (p === 'md' ? '# Titulo\\n**negrito** e [link](https://x.y)\\n- item\\n\`\`\`\\n**cru**\\n\`\`\`' : 'ECHO:' + p.split('\\n')[0]) + ' |model=' + get('--model') + ' |effort=' + get('--effort') + ' |resume=' + get('--resume') + ' |sys=' + Boolean(get('--append-system-prompt')) + ' |chat=' + process.env.WA_CHAT_ID, session_id: get('--resume') || 'sess-1', is_error: false, num_turns: 2, duration_ms: 1500 })); };
if (p === 'slow') setTimeout(out, 5000); else out();
`);

const fakeAgy = path.join(tmp, 'agy.mjs');
fs.writeFileSync(fakeAgy, '#!/usr/bin/env node\n'); fs.chmodSync(fakeAgy, 0o755);
fs.appendFileSync(fakeAgy, `
const a = process.argv.slice(2);
const get = (f) => a.includes(f) ? a[a.indexOf(f) + 1] : null;
const conv = get('--conversation') || 'agy-1';
console.log(JSON.stringify({ conversation_id: conv, status: 'SUCCESS', response: 'AGY:' + get('-p').split('\\n').slice(-1)[0] + ' |model=' + get('--model') + ' |conv=' + get('--conversation') + ' |sys=' + get('-p').includes('---'), duration_seconds: 1.5, num_turns: 1 }));
`);

const sent = [];
const waha = http.createServer((req, res) => {
  let b = []; req.on('data', (d) => b.push(d)); req.on('end', () => {
    if (req.headers['x-api-key'] !== 'k') { res.writeHead(401); return res.end(); }
    if (req.url.startsWith('/api/S/lids/')) { res.end(JSON.stringify({ lid: 'x', pn: '5511999990000@c.us' })); return; }
    if (req.url.startsWith('/api/files/')) { res.end(Buffer.from('PNGDATA')); return; }
    const body = Buffer.concat(b).toString();
    if (req.url === '/api/sendText') sent.push(JSON.parse(body).text);
    if (req.url === '/api/sendImage') { const j = JSON.parse(body); sent.push('[IMAGE ' + j.file.filename + ' ' + j.file.mimetype + ' cap=' + j.caption + ']'); }
    res.end('{}');
  });
}).listen(4011);

const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: '4012', WAHA_URL: 'http://localhost:4011/', WAHA_API_KEY: 'k', WAHA_SESSION: 'S',
    ALLOWED_NUMBERS: '+55 11 99999-0000', CLAUDE_BIN: fakeClaude, AGY_BIN: fakeAgy, HOME: tmp, CLAUDE_PERMISSION_MODE: 'bypassPermissions', SCHEDULER_TICK_MS: '1000', TZ: 'America/Sao_Paulo', CLAUDE_EFFORT: '' },
  stdio: 'inherit',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const C = '5511999990000@c.us';
async function hook(body, extra = {}) {
  const evt = { event: 'message', session: 'S', payload: { id: crypto.randomUUID(), from: C, fromMe: false, body, ...extra } };
  await fetch('http://localhost:4012/webhook', { method: 'POST', body: JSON.stringify(evt) });
  await sleep(250);
}
await sleep(800);
const step = async (label, fn) => { const n = sent.length; await fn(); await sleep(700); console.log('\n## ' + label); sent.slice(n).forEach((s) => console.log('  > ' + s.replace(/\n/g, ' ⏎ ').slice(0, 170))); };

await step('migração + resume', () => hook('oi'));
await step('/model opus', () => hook('/model opus'));
await step('mensagem usa opus', () => hook('a'));
await step('segunda mensagem continua opus', () => hook('b'));
await step('/effort high e inválido', async () => { await hook('/effort high'); await hook('/effort turbo'); });
await step('/new mantém modelo', async () => { await hook('/new'); await hook('c'); });
await step('markdown → whatsapp', () => hook('md'));
await step('fila + /status + /stop', async () => { await hook('slow'); await hook('depois'); await hook('/status'); await hook('/stop'); await sleep(500); });
await step('/model padrao', async () => { await hook('/model padrao'); await hook('d'); });
await step('imagem recebida', () => hook('o que é isso?', { hasMedia: true, media: { url: 'http://localhost:3000/api/files/S/abc.png', mimetype: 'image/png' } }));
await step('send-file local', async () => {
  fs.writeFileSync(path.join(tmp, 'workspace', 'grafico.png'), 'x');
  const r = await fetch('http://127.0.0.1:4012/send-file', { method: 'POST', body: JSON.stringify({ chatId: C, path: 'grafico.png', caption: 'segue' }) });
  console.log('  send-file status', r.status);
});
const S = 'http://127.0.0.1:4012/schedules';
const post = async (b) => { const r = await fetch(S, { method: 'POST', body: JSON.stringify(b) }); return r.status + ' ' + (await r.text()).replace(/\s+/g, ' ').slice(0, 120); };
const nowSP = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date());
const hh = nowSP.find((p) => p.type === 'hour').value, mm = nowSP.find((p) => p.type === 'minute').value;
let ids = {};
await step('agendamento: criar cron do minuto atual + at em 2s + inválidos', async () => {
  const a = await post({ chatId: C, cron: Number(mm) + ' ' + Number(hh) + ' * * *', description: 'diário teste', prompt: 'manda bom dia' });
  console.log('  cron ->', a); ids.cron = a.match(/"id": "(\w+)"/)[1];
  const b = await post({ chatId: C, at: new Date(Date.now() + 2000).toISOString(), description: 'lembrete único', prompt: 'lembra da reunião' });
  console.log('  at ->', b);
  console.log('  cron ruim ->', await post({ chatId: C, cron: '99 8 * * *', prompt: 'x' }));
  console.log('  chat desconhecido ->', await post({ chatId: 'x@c.us', cron: '0 8 * * *', prompt: 'x' }));
  await sleep(4000);
});
await step('/schedules (único já rodou e sumiu; cron mostra última execução)', () => hook('/schedules'));
await step('/pause e /cancel', async () => { await hook('/pause ' + ids.cron); await hook('/cancel #' + ids.cron); await hook('/schedules'); });
await step('/help', () => hook('/help'));
await step('/model sem argumento (menu numerado, pois o WAHA falso nao cria enquete) e resposta 2', async () => { await hook('/model'); await hook('2'); });
await step('/help e resposta 1 (status)', async () => { await hook('/help'); await hook('1'); });
await step('numero fora de menu vai para o Claude', () => hook('7'));
await step('/provider antigravity, depois mensagem vai para o agy (com instruções na 1ª vez)', async () => { await hook('/provider antigravity'); await hook('oi agy'); await hook('segunda'); });
await step('/provider claude volta ao Claude', async () => { await hook('/provider claude'); await hook('volta'); });
console.log('\ninbox:', fs.readdirSync(path.join(tmp, 'workspace', 'inbox')));
console.log('state:', fs.readFileSync(path.join(tmp, '.bridge', 'chats.json'), 'utf8').replace(/\s+/g, ' '));
bridge.kill(); waha.close(); process.exit(0);
