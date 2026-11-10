import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const tmp = path.join(dir, 'tmp3'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'workspace', 'a.pdf'), 'x');
const calls = [];
const waha = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
  calls.push(req.method + ' ' + req.url + ' ' + b.slice(0, 90));
  if (req.url.startsWith('/api/contacts/check-exists')) {
    const ph = new URL(req.url, 'http://x').searchParams.get('phone');
    // Brazilian 9th-digit normalization like WhatsApp does
    return res.end(JSON.stringify(ph.startsWith('5500') ? { numberExists: false } : { numberExists: true, chatId: '551190000000@c.us' }));
  }
  res.end('{}'); }); }).listen(4031);
const bridge = spawn(process.execPath, [path.join(dir, '..', 'bridge', 'bridge.mjs')], { env: { ...process.env, PORT: '4032', WAHA_URL: 'http://localhost:4031',
  WAHA_API_KEY: 'k', WAHA_SESSION: 'S', ALLOWED_NUMBERS: '5511999990000', CLAUDE_BIN: 'x.mjs', HOME: tmp }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const p = async (u, b) => { const r = await fetch('http://127.0.0.1:4032' + u, { method: 'POST', body: JSON.stringify(b) }); return r.status + ' ' + (await r.text()); };
console.log('send ok      ->', await p('/send', { to: '+55 11 99402-6755', text: '**oi**' }));
console.log('sem whatsapp ->', await p('/send', { to: '5500123456789', text: 'oi' }));
console.log('curto        ->', await p('/send', { to: '1234', text: 'oi' }));
console.log('vazio        ->', await p('/send', { to: '5511900000000', text: ' ' }));
console.log('grupo        ->', await p('/send', { to: '1203@g.us', text: 'oi' }));
console.log('file to      ->', await p('/send-file', { to: '5511900000000', path: 'a.pdf' }));
console.log('file chat ?? ->', await p('/send-file', { chatId: 'x@c.us', path: 'a.pdf' }));
const hook = async (body) => { await fetch('http://127.0.0.1:4032/webhook', { method: 'POST', body: JSON.stringify({ event: 'message', session: 'S', payload: { id: 'm' + Math.random(), from: '5511999990000@c.us', fromMe: false, body } }) }); await new Promise((r) => setTimeout(r, 400)); };
await hook('/send +55 11 99402-6755 oi, tudo bem?\nlinha 2');
await hook('/send 5500123456789 oi');
await hook('/send oi');
calls.forEach((c) => console.log('  waha:', c));
bridge.kill(); waha.close(); process.exit(0);
