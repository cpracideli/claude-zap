// The bridge starts a fake ai-memory server, reports it in /health, and restarts it after it dies.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const tmp = path.join(dir, 'tmp-aimem'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(path.join(tmp, '.local', 'bin'), { recursive: true });
const bin = path.join(tmp, '.local', 'bin', 'ai-memory');
fs.writeFileSync(bin, '#!' + process.execPath + `
import http from 'node:http';
const s = http.createServer((q, r) => { if (q.url === '/healthz') { r.setHeader('Content-Type', 'application/json'); return r.end('{"status":"ok"}'); } if (q.url === '/die') { r.end('bye'); process.exit(3); } r.end(); });
s.listen(4022, '127.0.0.1', () => console.log('fake ai-memory up', process.argv.slice(2).join(' ')));
`);
fs.chmodSync(bin, 0o755);
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], {
  env: { ...process.env, PORT: '4021', HOME: tmp, WAHA_URL: 'http://127.0.0.1:9', STARTUP_NOTICE: 'false', ALLOWED_NUMBERS: '1', AI_MEMORY_SERVER_URL: 'http://127.0.0.1:4022/', AGY_BIN: '/nonexistent' },
  stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => (await (await fetch('http://127.0.0.1:4021/health')).json()).aiMemory;
let ok = true;
const check = (label, cond, v) => { console.log((cond ? 'PASS ' : 'FAIL ') + label, JSON.stringify(v)); ok = ok && cond; };
await sleep(7000);
let h = await health(); check('started and healthy', h.status === 'ok' && h.supervised, h);
await fetch('http://127.0.0.1:4022/die').catch(() => {});
await sleep(1000);
h = await health(); check('noticed the crash', h.status.startsWith('parado') && h.restarts === 1, h);
await sleep(10000);
h = await health(); check('restarted after backoff', h.status === 'ok' && h.supervised, h);
console.log(fs.readFileSync(path.join(tmp, '.bridge', 'ai-memory.log'), 'utf8').trim());
bridge.kill('SIGTERM'); await sleep(300);
spawn('pkill', ['-f', bin]);
console.log(ok ? 'AI-MEMORY OK' : 'AI-MEMORY FAILED'); process.exit(ok ? 0 : 1);
