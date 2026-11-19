// WhatsApp (WAHA) <-> Claude Code bridge. No dependencies, Node 20+.
// NOTE: this file is embedded in a docker-compose file, so it must not contain the dollar sign.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Drop empty variables (compose sets unset ones to "") so Claude Code picks the auth that is really set.
for (const k of Object.keys(process.env)) if (process.env[k] === '') delete process.env[k];
const env = process.env;

const PORT = Number(env.PORT || 3000);
const WAHA_API_KEY = env.WAHA_API_KEY || '';
const WAHA_SESSION = env.WAHA_SESSION || 'default';
const WEBHOOK_HMAC_KEY = env.WEBHOOK_HMAC_KEY || '';
const ALLOWED = String(env.ALLOWED_NUMBERS || '').split(/[,;\n]+/).map((n) => n.replace(/\D/g, '')).filter(Boolean);
const CLAUDE_BIN = env.CLAUDE_BIN || 'claude';
const AGY_BIN = env.AGY_BIN || path.join(env.HOME || '/tmp', '.local', 'bin', 'agy');
const PROVIDERS = { claude: 'Claude Code', antigravity: 'Antigravity' };
// Claude keeps its memory notes here; Antigravity gets the same folder so it can read them too.
const MEMORY_DIR = env.MEMORY_DIR || path.join(env.HOME || '/tmp', '.claude', 'projects', '-home-node-workspace', 'memory');
const WORKDIR = env.CLAUDE_WORKDIR || path.join(env.HOME || '/tmp', 'workspace');
const INBOX = path.join(WORKDIR, 'inbox');
const DATA_DIR = env.DATA_DIR || path.join(env.HOME || '/tmp', '.bridge');
const PERMISSION_MODE = env.CLAUDE_PERMISSION_MODE || 'default';
const ALLOWED_TOOLS = env.CLAUDE_ALLOWED_TOOLS || 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,TodoWrite';
const ENV_MODEL = env.CLAUDE_MODEL || '';
const ENV_EFFORT = env.CLAUDE_EFFORT || '';
const TIMEOUT_MS = Number(env.CLAUDE_TIMEOUT_SECONDS || 1800) * 1000;
const TZ = env.TZ || 'America/Sao_Paulo';
const MAX_CHUNK = 3500;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Short hash of this file: shows in /health and in the startup log, so you can tell which code is really running.
const VERSION = crypto.createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 12);

fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- persistent per-chat state ----------
const STATE_FILE = path.join(DATA_DIR, 'chats.json');
let chats = {};
try { chats = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
try { // migrate the old sessions.json (chatId -> sessionId)
  const old = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8'));
  for (const [k, v] of Object.entries(old)) if (!chats[k]) chats[k] = { session: v };
  fs.writeFileSync(STATE_FILE, JSON.stringify(chats, null, 2));
  fs.renameSync(path.join(DATA_DIR, 'sessions.json'), path.join(DATA_DIR, 'sessions.json.migrated'));
} catch {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(chats, null, 2));
const chat = (id) => (chats[id] = chats[id] || {});

// Global settings changed from the web panel: default provider for chats that never picked one, default model/effort.
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
const providerOf = (c) => c.provider || settings.defaultProvider || 'claude';
const defModel = () => settings.claudeModel || ENV_MODEL;
const defEffort = () => settings.claudeEffort || ENV_EFFORT;
// Conversations started from the web panel use ids "web:<hex>". Their replies go to a history file, not to WhatsApp.
const isWeb = (chatId) => String(chatId).startsWith('web:');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const wahaBase = () => {
  let u = String(env.WAHA_URL || 'http://localhost:3000');
  while (u.endsWith('/')) u = u.slice(0, -1);
  return u;
};

async function waha(method, p, body) {
  const res = await fetch(wahaBase() + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error('WAHA ' + method + ' ' + p + ' -> ' + res.status + ' ' + text.slice(0, 200));
  try { return JSON.parse(text); } catch { return text; }
}

// Resolve the sender to a phone number. Newer WhatsApp ids may be "@lid" instead of "@c.us".
const lidCache = new Map();
async function senderNumber(msg) {
  const ids = [msg.participant, msg.from, msg._data && msg._data.Info && msg._data.Info.SenderAlt].filter(Boolean);
  for (const id of ids) {
    if (/@(c\.us|s\.whatsapp\.net)/.test(id)) return id.split('@')[0].split(':')[0];
  }
  const lid = ids.find((id) => id.endsWith('@lid'));
  if (!lid) return '';
  if (lidCache.has(lid)) return lidCache.get(lid);
  try {
    const r = await waha('GET', '/api/' + encodeURIComponent(WAHA_SESSION) + '/lids/' + encodeURIComponent(lid));
    const pn = String((r && (r.pn || r.phoneNumber)) || '').split('@')[0];
    lidCache.set(lid, pn);
    return pn;
  } catch (e) { log('lid lookup failed', e.message); return ''; }
}

// ---------- WhatsApp formatting ----------
function toWhatsApp(md) {
  // Leave code blocks untouched; convert the rest from Markdown to WhatsApp markup.
  return md.split('```').map((part, i) => {
    if (i % 2 === 1) return part;
    return part.split('\n').map((line) => {
      const h = line.match(/^\s{0,3}#{1,6}\s+(.*)/);
      if (h) line = '*' + h[1].replace(/\*+/g, '') + '*';
      line = line.replace(/\*\*(.+?)\*\*/g, (m, g) => '*' + g + '*');
      line = line.replace(/__(.+?)__/g, (m, g) => '_' + g + '_');
      line = line.replace(/~~(.+?)~~/g, (m, g) => '~' + g + '~');
      line = line.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (m, t, u) => (t === u ? u : t + ' (' + u + ')'));
      line = line.replace(/^(\s*)[-*]\s+/, (m, s) => s + '• ');
      return line;
    }).join('\n');
  }).join('```');
}

function chunks(text) {
  const parts = [];
  let rest = text.trim() || '(resposta vazia)';
  while (rest.length > MAX_CHUNK) {
    let cut = rest.lastIndexOf('\n', MAX_CHUNK);
    if (cut < MAX_CHUNK / 2) cut = MAX_CHUNK;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  parts.push(rest);
  return parts;
}

async function reply(chatId, text, raw) {
  if (isWeb(chatId)) return webAppend(chatId, { role: 'assistant', text: String(text) });
  for (const part of chunks(raw ? text : toWhatsApp(text))) {
    await waha('POST', '/api/sendText', { session: WAHA_SESSION, chatId, text: part });
  }
}

// ---------- live status: one message that is edited while Claude works and deleted when the answer is sent ----------
const msgIdOf = (r) => (r && r.id && (r.id._serialized || r.id)) || null;
const msgPath = (chatId, id) => '/api/' + WAHA_SESSION + '/chats/' + chatId + '/messages/' + id;
function liveStatus(chatId) {
  const started = Date.now();
  let label = 'trabalhando';
  let id = null;
  let last = '';
  const ready = waha('POST', '/api/sendText', { session: WAHA_SESSION, chatId, text: '⏳ trabalhando...' })
    .then((r) => { id = msgIdOf(r); log('status message', id ? 'started' : 'started without id (edits disabled)'); })
    .catch((e) => log('status start failed', e.message));
  let queue = Promise.resolve();
  const push = async () => {
    await ready;
    if (!id) return;
    const secs = Math.round((Date.now() - started) / 1000);
    const text = '⏳ ' + label + ' (' + (secs >= 60 ? Math.round(secs / 60) + ' min' : secs + ' s') + ')';
    if (text === last) return;
    last = text;
    await waha('PUT', msgPath(chatId, id), { text }).catch((e) => log('status edit failed', e.message));
  };
  const tick = () => { queue = queue.then(push); };
  const timer = setInterval(tick, 15000);
  return {
    activity(l) { label = l; tick(); },
    async finish() {
      clearInterval(timer);
      await ready;
      await queue;
      if (id) {
        await waha('DELETE', msgPath(chatId, id) + '?onlyLocally=false')
          .then(() => log('status message deleted')).catch((e) => log('status delete failed', e.message));
      }
    },
  };
}

// ---------- Claude ----------
function systemPrompt(chatId) {
  const web = isWeb(chatId);
  return [
    web
      ? 'Você está conversando com o usuário pelo painel web (Agent Control), ligado à mesma ponte do WhatsApp que roda num container Docker. Este chat NÃO é o WhatsApp.'
      : 'Você está conversando com o usuário pelo WhatsApp, através de uma ponte (WAHA) que roda num container Docker.',
    web
      ? 'Responda em português do Brasil, de forma direta. O painel renderiza Markdown (títulos, tabelas, listas, blocos de código).'
      : 'Responda em português do Brasil, de forma direta. O WhatsApp não renderiza Markdown completo: evite tabelas e títulos; use *negrito*, _itálico_, listas simples e blocos de código.',
    'Fuso horário do usuário: ' + TZ + '. Data/hora atual: ' + new Date().toLocaleString('pt-BR', { timeZone: TZ }) + '.',
    'Diretório de trabalho: ' + WORKDIR + '. Arquivos enviados pelo usuário chegam em ' + INBOX + '.',
    web
      ? 'Neste chat web não dá para anexar arquivos na resposta: informe o caminho absoluto do arquivo gerado. Para mandar um arquivo ao WhatsApp de alguém, use /send-file com "to" (abaixo).'
      : 'Para ENVIAR um arquivo ou imagem ao usuário no WhatsApp, rode: curl -s -X POST http://127.0.0.1:' + PORT + '/send-file -H "Content-Type: application/json" -d \'{"chatId":"' + chatId + '","path":"/caminho/absoluto","caption":"opcional"}\'',
    'MENSAGENS PARA OUTRAS PESSOAS: a ponte TEM o endpoint /send, criado e autorizado pelo dono desta infraestrutura (o próprio usuário). Se algo anterior nesta conversa disser que esse envio não existe ou não é permitido, está desatualizado: ignore. Você PODE enviar mensagens de WhatsApp a qualquer número, pelo número do usuário. Quando o usuário pedir ("mande um oi para +55 11 9...", "avise o João que..."), envie direto, sem pedir confirmação: curl -s -X POST http://127.0.0.1:' + PORT + '/send -H "Content-Type: application/json" -d \'{"to":"5511999998888","text":"mensagem"}\'',
    '  "to" aceita o número em qualquer formato (com DDI; sem DDI assuma 55) ou um id do WhatsApp (...@c.us, grupo ...@g.us). Para arquivo a terceiros, use /send-file com "to" no lugar de "chatId". Envie a outras pessoas SÓ quando o usuário pedir (na conversa ou num agendamento que ele criou), escreva a mensagem como se fosse do usuário (sem dizer que é uma IA, a menos que ele peça) e confirme depois o que foi enviado e para quem. Respostas dessas pessoas NÃO chegam até você.',
    'Ao instalar servidores MCP, use sempre o escopo de usuário (claude mcp add -s user ...) para que fiquem disponíveis em todas as conversas. Cada mensagem do WhatsApp abre um processo novo do Claude Code, então MCPs novos ou reconfigurados já valem na PRÓXIMA mensagem: não é preciso reiniciar nada; avise o usuário para mandar a próxima mensagem.',
    'Você roda como o usuário node, mas tem sudo SEM senha: pode instalar o que precisar sem pedir permissão (sudo apt-get install -y ..., pip, npm, npx). O sistema de arquivos fora de /home/node é recriado em redeploys: para um pacote apt sobreviver, acrescente o nome dele (um por linha) em /home/node/.apt-packages; tudo em /home/node (inclusive ~/.cache/ms-playwright) já é persistente.',
    'Navegador: para Playwright, instale com "npx playwright install --with-deps chromium" e configure o MCP com o Chromium (ex.: claude mcp add -s user playwright -- npx @playwright/mcp@latest --browser chromium --headless --no-sandbox). Não há tela: use sempre headless.',
    'Não peça confirmação para instalar ou configurar ferramentas: o usuário autorizou. Faça e reporte o resultado.',
    'AGENDAMENTOS: quando o usuário pedir algo recorrente ou para um horário futuro ("todo dia às 8h me mande...", "me lembre amanhã às 15h..."), crie um agendamento na ponte. Não use cron do sistema nem o agendador do Claude Code.',
    '  Recorrente (cron de 5 campos: minuto hora dia mês dia-da-semana, no fuso ' + TZ + '): curl -s -X POST http://127.0.0.1:' + PORT + '/schedules -H "Content-Type: application/json" -d \'{"chatId":"' + chatId + '","cron":"0 8 * * *","description":"resumo curto","prompt":"instrução completa e autossuficiente do que fazer e enviar"}\'',
    '  Uma vez: troque "cron" por "at":"2026-11-10T15:00:00-03:00" (ISO 8601 com fuso).',
    '  Listar: curl -s "http://127.0.0.1:' + PORT + '/schedules?chatId=' + encodeURIComponent(chatId) + '"   Remover: curl -s -X DELETE http://127.0.0.1:' + PORT + '/schedules/ID',
    '  O prompt do agendamento roda depois numa sessão NOVA, sem o contexto desta conversa: escreva-o completo (o que buscar, como formatar, o que enviar). A resposta final daquela execução é enviada automaticamente ao usuário. Confirme ao usuário o id, o horário e o que será enviado.',
    'Comandos da ponte que o usuário pode usar: /help, /new, /status, /usage, /log, /model, /effort, /stop, /send, /schedules, /pause, /resume, /cancel.',
  ].join('\n');
}

// Human-readable label for a tool call, shown in the live status message.
function describeTool(name) {
  const labels = { Bash: 'executando comando', Read: 'lendo arquivo', Write: 'escrevendo arquivo', Edit: 'editando arquivo',
    MultiEdit: 'editando arquivo', Glob: 'procurando arquivos', Grep: 'buscando no código', WebSearch: 'pesquisando na web',
    WebFetch: 'abrindo página', TodoWrite: 'organizando tarefas', Task: 'delegando subtarefa' };
  return labels[name] || ('usando ' + name);
}

function runClaude(chatId, prompt, opts, onActivity, onEvent) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', PERMISSION_MODE,
      '--append-system-prompt', systemPrompt(chatId)];
    if (ALLOWED_TOOLS && PERMISSION_MODE !== 'bypassPermissions') args.push('--allowedTools', ALLOWED_TOOLS);
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.resume) args.push('--resume', opts.resume);
    const isScript = CLAUDE_BIN.endsWith('.mjs') || CLAUDE_BIN.endsWith('.js');
    const child = spawn(isScript ? process.execPath : CLAUDE_BIN, isScript ? [CLAUDE_BIN, ...args] : args,
      { cwd: WORKDIR, env: { ...env, WA_CHAT_ID: chatId }, stdio: ['ignore', 'pipe', 'pipe'] });
    running.set(chatId, { child, started: Date.now(), prompt: prompt.slice(0, 80) });
    let out = '', err = '', timedOut = false, buf = '', final = null;
    // stream-json: one JSON event per line. Tool calls drive the live status; the "result" event is the answer.
    child.stdout.on('data', (d) => {
      out += d;
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (onEvent) { try { onEvent(ev); } catch (e) { log('onEvent failed', e.message); } }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content) && onActivity) {
          for (const block of ev.message.content) if (block.type === 'tool_use') onActivity(describeTool(block.name));
        }
        if (ev.type === 'result') final = ev;
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, TIMEOUT_MS);
    const done = (r) => { clearTimeout(timer); running.delete(chatId); resolve(r); };
    child.on('error', (e) => done({ error: e.message }));
    child.on('close', (code, signal) => {
      if (signal && !timedOut) return done({ stopped: true });
      if (timedOut) return done({ error: 'tempo limite de ' + TIMEOUT_MS / 60000 + ' min atingido', timedOut: true });
      try {
        if (!final) throw new Error('no result event');
        done({ text: final.result || '', sessionId: final.session_id, isError: final.is_error,
          usage: { cost: final.total_cost_usd, ms: final.duration_ms, turns: final.num_turns } });
        logUsage('claude', chatId, final.total_cost_usd, final.duration_ms, final.usage);
      } catch {
        done({ error: 'claude saiu com código ' + code + ': ' + (err || out).slice(-500) });
      }
    });
  });
}

// ---------- Antigravity (agy) provider ----------
// Runs `agy -p` in print mode. It keeps its own conversations (--conversation <id>), so each chat stores
// the agy conversation id separately from the Claude session. The bridge's instructions are sent in the
// first prompt of a new agy conversation, because agy has no --append-system-prompt.
function runAntigravity(chatId, prompt, opts) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (fs.existsSync(MEMORY_DIR)) args.push('--add-dir', MEMORY_DIR);
    if (PERMISSION_MODE === 'bypassPermissions') args.push('--dangerously-skip-permissions');
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (opts.resume) args.push('--conversation', opts.resume);
    const started = Date.now();
    const child = spawn(AGY_BIN, args, { cwd: WORKDIR, env: { ...env, WA_CHAT_ID: chatId }, stdio: ['ignore', 'pipe', 'pipe'] });
    running.set(chatId, { child, started: Date.now(), prompt: prompt.slice(0, 80) });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, TIMEOUT_MS);
    const done = (r) => { clearTimeout(timer); running.delete(chatId); resolve(r); };
    child.on('error', (e) => done({ error: e.message }));
    child.on('close', (code, signal) => {
      if (signal && !timedOut) return done({ stopped: true });
      if (timedOut) return done({ error: 'tempo limite de ' + TIMEOUT_MS / 60000 + ' min atingido', timedOut: true });
      try {
        const j = JSON.parse(out);
        if (j.status && j.status !== 'SUCCESS') return done({ error: 'Antigravity: ' + j.status, sessionId: j.conversation_id });
        const u = j.usage || {};
        logUsage('antigravity', chatId, 0, Math.round((j.duration_seconds || 0) * 1000), u);
        done({ text: j.response || '', sessionId: j.conversation_id, provider: 'antigravity',
          usage: { cost: 0, ms: Math.round((j.duration_seconds || (Date.now() - started) / 1000) * 1000), turns: j.num_turns || 0 } });
      } catch {
        done({ error: 'agy saiu com código ' + code + ': ' + (err || out).slice(-500) });
      }
    });
  });
}

// ---------- Antigravity model catalog, read live from `agy models` ----------
// Google ships new Gemini models often, so the menu is never hard-coded. Model ids may carry the effort as a
// suffix (gemini-x-flash-medium): those are grouped into one model with its effort variants.
const AGY_CATALOG_TTL = 10 * 60 * 1000;
const EFFORT_SUFFIX = new RegExp('^(.+)-(' + EFFORTS.join('|') + ')(?:-preview)?\x24', 'i');
let agyCatalog = { at: 0, models: [], raw: '' };
const agyEffortCache = new Map(); // model id -> [effort]

function execAgy(args, ms = 30000) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn(AGY_BIN, args, { cwd: WORKDIR, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const timer = setTimeout(() => child.kill('SIGTERM'), ms);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
// "gemini-3.8-flash" -> "Gemini 3.8 Flash", "claude-opus-5-5" -> "Claude Opus 5.5"
const prettyModel = (id) => id.replace(/(\d)-(?=\d)/g, '\x241.').split(/[-_]/).filter(Boolean)
  .map((w) => (['gpt', 'oss'].includes(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

// Turns `agy models` output (JSON or a text table/list) into [{ id, label, efforts?: [] }].
function parseAgyModels(out) {
  const text = stripAnsi(out).trim();
  const found = [];
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : (j.models || j.data || j.items || []);
    for (const m of arr) {
      if (typeof m === 'string') { found.push({ id: m }); continue; }
      const id = m.id || m.model || m.slug || m.name;
      if (!id) continue;
      const ef = m.efforts || m.effort_levels || m.effortLevels || m.reasoning_efforts || m.available_efforts || m.availableEfforts;
      found.push({ id: String(id), label: m.display_name || m.displayName || m.label || m.title || (m.name !== id ? m.name : ''),
        efforts: Array.isArray(ef) ? ef.map((x) => String(x.id || x.name || x).toLowerCase()).filter((x) => EFFORTS.includes(x)) : undefined });
    }
    if (found.length) return found;
  } catch {}
  // Text: take the first model-looking token of each line (lowercase, with a dash), the rest is its label.
  const idRe = /(?:^|[\s*>|•\-]\s*)([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+(?:@[a-z0-9.-]+)?)(?=\s|[|,(]|(?![\s\S]))/;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || /^(usage|error|available models|warning)/i.test(t)) continue;
    // a dashed id anywhere, or a one-word id in the first column of a table ("orchestrator   Orchestrator")
    const m = t.match(idRe) || t.match(/^[*>•\-\s]*([a-z][a-z0-9._]*)\s{2,}\S/);
    if (!m) continue;
    const rest = t.slice(t.indexOf(m[1]) + m[1].length).replace(/[|()\[\]*]/g, ' ').replace(/\b(current|default|selected)\b/gi, '').replace(/\s+/g, ' ').trim();
    found.push({ id: m[1], label: rest && !new RegExp('^[a-z0-9.-]+\x24').test(rest) && rest.length < 40 ? rest : '' });
  }
  return found;
}

// Groups variants: [{ base, label, ids: [id], variants: { effort: id }, efforts: [effort] }]
function groupAgyModels(list) {
  const map = new Map();
  for (const m of list) {
    const s = m.id.match(EFFORT_SUFFIX);
    const base = s ? s[1] : m.id;
    const g = map.get(base) || { base, label: '', ids: [], variants: {}, efforts: [] };
    g.ids.push(m.id);
    if (s) g.variants[s[2].toLowerCase()] = m.id;
    if (m.efforts) g.efforts = m.efforts;
    if (!g.label && m.label) g.label = m.label.replace(new RegExp('\\s*[(-]?\\s*(' + EFFORTS.join('|') + ')\\s*\\)?\\s*\x24', 'i'), '');
    map.set(base, g);
  }
  for (const g of map.values()) {
    if (!g.label) g.label = prettyModel(g.base);
    const fromVariants = Object.keys(g.variants);
    if (fromVariants.length) g.efforts = fromVariants;
    g.efforts = EFFORTS.filter((e) => g.efforts.includes(e));
  }
  return [...map.values()];
}

async function refreshAgyCatalog(force) {
  if (!force && agyCatalog.models.length && Date.now() - agyCatalog.at < AGY_CATALOG_TTL) return agyCatalog;
  for (const args of [['models', '--output-format', 'json'], ['models', '--json'], ['models']]) {
    const r = await execAgy(args, 30000);
    if (r.code !== 0) continue;
    const models = groupAgyModels(parseAgyModels(r.out));
    if (models.length) { agyCatalog = { at: Date.now(), models, raw: r.out }; return agyCatalog; }
  }
  log('agy models: could not read the model list, keeping', agyCatalog.models.length, 'cached');
  return agyCatalog;
}

// Finds the catalog entry for what the user typed or what is stored: base id, full variant id or label.
function findAgyModel(value) {
  if (!value) return null;
  const v = value.toLowerCase().trim();
  return agyCatalog.models.find((g) => g.base.toLowerCase() === v || g.ids.some((id) => id.toLowerCase() === v))
    || agyCatalog.models.find((g) => g.label.toLowerCase() === v)
    || null;
}

// Effort levels for a model that has no variants in its id: ask agy itself (`/effort` in print mode).
async function agyEfforts(g) {
  if (!g) return ['low', 'medium', 'high'];
  if (g.efforts.length) return g.efforts;
  if (agyEffortCache.has(g.base)) return agyEffortCache.get(g.base);
  const r = await execAgy(['-p', '/effort', '--output-format', 'json', '--model', g.base], 20000);
  let list = [];
  const walk = (x, key) => {
    if (Array.isArray(x)) { if (/avail|tier|level|option|effort/i.test(key || '')) for (const y of x) if (EFFORTS.includes(String(y).toLowerCase())) list.push(String(y).toLowerCase()); x.forEach((y) => walk(y, key)); }
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, k);
  };
  try { walk(JSON.parse(stripAnsi(r.out))); } catch {}
  if (!list.length) { const m = stripAnsi(r.out + ' ' + r.err).match(/available:\s*([a-z, ]+)/i); if (m) list = m[1].split(/[,\s]+/).filter((x) => EFFORTS.includes(x)); }
  if (!list.length && /not adjustable|fixed|takes no|doesn.t support|does not support/i.test(r.out + r.err)) list = [];
  else if (!list.length) list = ['low', 'medium', 'high'];
  list = EFFORTS.filter((e) => list.includes(e));
  agyEffortCache.set(g.base, list);
  return list;
}

// What actually goes to `agy`: a variant id when the model encodes effort in its id, else --model + --effort.
function resolveAgyRun(c) {
  const g = findAgyModel(c.agyModel);
  if (!g) return { model: c.agyModel || '', effort: c.agyEffort || '' };
  if (Object.keys(g.variants).length) {
    const stored = (c.agyModel.match(EFFORT_SUFFIX) || [])[2];
    const want = (c.agyEffort || (stored && stored.toLowerCase()) || '');
    const eff = g.variants[want] ? want : (g.variants.medium ? 'medium' : g.efforts[Math.floor(g.efforts.length / 2)]);
    return { model: g.variants[eff] || g.ids[0], effort: '' };
  }
  const effort = c.agyEffort && (!agyEffortCache.has(g.base) || agyEffortCache.get(g.base).includes(c.agyEffort)) ? c.agyEffort : '';
  return { model: g.ids[0], effort };
}
const agyModelLabel = (c) => { const g = findAgyModel(c.agyModel); return g ? g.label + ' (' + g.base + ')' : (c.agyModel || 'padrão'); };

// ---------- ai-memory server (github.com/akitaonrails/ai-memory) ----------
// Its installer starts the server as a systemd --user service, and containers have no systemd, so after every
// redeploy the server was simply gone (MCP calls and hooks failed silently). The bridge now keeps it running:
// it starts `ai-memory serve` when nothing answers /healthz, restarts it with backoff, and checks every minute.
// Turn off with AI_MEMORY=off. Binary and data live in the persistent home volume.
const AI_MEMORY_URL = String(env.AI_MEMORY_SERVER_URL || 'http://127.0.0.1:49374').replace(/\/+(?![\s\S])/, '');
const AI_MEMORY_LOG = path.join(DATA_DIR, 'ai-memory.log');
const aiMemory = { child: null, status: 'off', restarts: 0, backoff: 5000, timer: null };
function findBin(name, extra) {
  const dirs = [...(extra || []), ...String(env.PATH || '').split(':')];
  for (const d of dirs) { const f = path.join(d, name); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {} }
  return '';
}
const aiMemoryBin = () => env.AI_MEMORY_BIN || findBin('ai-memory', [path.join(env.HOME || '/tmp', '.local', 'bin'),
  path.join(env.HOME || '/tmp', '.cargo', 'bin'), path.join(env.HOME || '/tmp', '.local', 'share', 'mise', 'shims')]);
async function aiMemoryHealthy() {
  try {
    const r = await fetch(AI_MEMORY_URL + '/healthz', { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return r.ok && j && j.status === 'ok';
  } catch { return false; }
}
async function ensureAiMemory() {
  if (env.AI_MEMORY === 'off') return;
  if (aiMemory.child) { // ours is running: refresh the status, and show its log once if it never answers
    const healthy = await aiMemoryHealthy();
    if (healthy && aiMemory.status !== 'ok') log('ai-memory: healthy at', AI_MEMORY_URL);
    if (!healthy && aiMemory.status === 'iniciando') {
      let tail = ''; try { tail = fs.readFileSync(AI_MEMORY_LOG, 'utf8').slice(-1200); } catch {}
      log('ai-memory: running but /healthz does not answer at', AI_MEMORY_URL, '| log tail:', JSON.stringify(tail));
    }
    aiMemory.status = healthy ? 'ok' : 'rodando, sem resposta em /healthz';
    return;
  }
  const bin = aiMemoryBin();
  if (!bin) { aiMemory.status = 'não instalado'; return; }
  if (await aiMemoryHealthy()) { aiMemory.status = 'ok'; aiMemory.backoff = 5000; return; }
  if (aiMemory.timer) return; // a restart is already scheduled
  const out = fs.openSync(AI_MEMORY_LOG, 'a');
  log('ai-memory: starting', bin, 'serve');
  const child = spawn(bin, ['serve', '--transport', 'http', '--enable-web'], { cwd: env.HOME || '/tmp', env, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  aiMemory.child = child; aiMemory.status = 'iniciando';
  const started = Date.now();
  child.on('error', (e) => log('ai-memory: failed to start:', e.message));
  child.on('close', (code, signal) => {
    aiMemory.child = null; aiMemory.status = 'parado (código ' + (signal || code) + ')';
    if (Date.now() - started > 60000) aiMemory.backoff = 5000; // ran fine for a while: restart fast
    log('ai-memory: exited with', signal || code, '| restarting in', aiMemory.backoff / 1000, 's | see', AI_MEMORY_LOG);
    aiMemory.restarts += 1;
    aiMemory.timer = setTimeout(() => { aiMemory.timer = null; ensureAiMemory().catch(() => {}); }, aiMemory.backoff);
    aiMemory.backoff = Math.min(aiMemory.backoff * 2, 300000);
  });
  setTimeout(async () => { if (aiMemory.child === child && await aiMemoryHealthy()) { aiMemory.status = 'ok'; log('ai-memory: healthy at', AI_MEMORY_URL); } }, 5000);
}

// Instructions for Antigravity: the same bridge rules as Claude, plus where memory and tools are.
function antigravityPrompt(chatId) {
  const memory = fs.existsSync(MEMORY_DIR)
    ? 'Memória do Caio: leia primeiro o arquivo MEMORY.md na pasta ' + MEMORY_DIR + ' e abra os arquivos que forem relevantes para o pedido. Lá estão os dados de contato, acessos e preferências.'
    : 'Não há pasta de memória configurada.';
  return [
    systemPrompt(chatId),
    memory,
    'Você é o Antigravity respondendo pela ponte. Use as mesmas credenciais e ferramentas do ambiente: GitHub (gh já autenticado), Coolify, WAHA, Gmail e os scripts em ~/bin. Os arquivos de acesso ficam em ~/.config.',
    'Para instalar servidores MCP neste agente, use: agy mcp add -- <nome> <comando> (ou a URL, para servidores HTTP). Não use o comando claude mcp.',
  ].join('\n\n');
}

// One entry point for chat jobs and schedules: runs the provider chosen for this chat.
function runAgent(chatId, prompt, opts, onActivity, onEvent) {
  const c = chat(chatId);
  if (providerOf(c) === 'antigravity') {
    const first = !opts.resume;
    const text = first ? antigravityPrompt(chatId) + '\n\n---\n\n' + prompt : prompt;
    const pick = resolveAgyRun(c);
    return runAntigravity(chatId, text, { model: pick.model, effort: pick.effort, resume: opts.resume });
  }
  return runClaude(chatId, prompt, opts, onActivity, onEvent);
}

// ---------- queue / running ----------
const queues = new Map();   // chatId -> promise chain
const pending = new Map();  // chatId -> number of queued jobs
const running = new Map();  // chatId -> { child, started, prompt }
function enqueue(chatId, job) {
  pending.set(chatId, (pending.get(chatId) || 0) + 1);
  const prev = queues.get(chatId) || Promise.resolve();
  const next = prev.then(job).catch((e) => log('job error', e.message))
    .finally(() => pending.set(chatId, (pending.get(chatId) || 1) - 1));
  queues.set(chatId, next);
  next.finally(() => { if (queues.get(chatId) === next) queues.delete(chatId); });
}

const fmtDur = (ms) => (ms >= 60000 ? Math.round(ms / 60000) + ' min' : Math.round(ms / 1000) + ' s');

// ---------- run history, usage and audit ----------
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
function audit(entry) {
  try { fs.appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); }
  catch (e) { log('audit write failed', e.message); }
}
// Keeps the last 20 runs per chat (for /log) and running totals (for /usage).
function recordRun(chatId, entry) {
  const c = chat(chatId);
  c.runs = [...(c.runs || []), { at: new Date().toISOString(), ...entry }].slice(-20);
  c.totals = c.totals || { runs: 0, cost: 0, ms: 0, errors: 0 };
  c.totals.runs += 1;
  c.totals.cost += entry.cost || 0;
  c.totals.ms += entry.ms || 0;
  if (entry.error) c.totals.errors += 1;
  save();
}

// ---------- commands (answered immediately, outside the queue) ----------
const HELP = [
  '*Todos os comandos*',
  '/new: começa uma conversa nova (mantém modelo e esforço)',
  '/status: sessão, modelo, tarefa em andamento e totais',
  '/log [n]: últimas n execuções (padrão 5) com horário, duração, custo e erros',
  '/usage: total de execuções, tempo e custo desta conversa',
  '/provider [claude|antigravity]: escolhe quem responde nesta conversa (fica salvo)',
  '/model [opus|sonnet|haiku|fable|<id>|default]: troca o modelo desta conversa (fica salvo). No Antigravity, a lista vem ao vivo do agy models',
  '/effort [low|medium|high|xhigh|max|default]: nível de esforço (fica salvo). No Antigravity, mostra só os níveis do modelo escolhido',
  '/stop: interrompe a tarefa em andamento',
  '/send <número> <mensagem>: manda uma mensagem para outro número (direto, sem passar pelo Claude)',
  '/schedules: lista os agendamentos',
  '/pause <id>: pausa ou retoma um agendamento',
  '/resume <id>: retoma um agendamento pausado',
  '/cancel <id>: remove um agendamento',
  '/help: esta lista',
  'Para agendar, peça em linguagem natural: "todo dia às 8h me mande a previsão do tempo".',
  'Qualquer outro texto vai para o Claude Code. Imagens, áudios e documentos são salvos em inbox/ e o caminho é passado ao Claude.',
].join('\n');

// ---------- tap-to-choose: WhatsApp polls, with a numbered menu as fallback ----------
// Buttons and list messages only work on the official WhatsApp Business API; polls work on WAHA Core.
const MODEL_CHOICES = [['Opus', '/model opus'], ['Sonnet', '/model sonnet'], ['Haiku', '/model haiku'], ['Fable', '/model fable'], ['Padrão da conta', '/model default']];
const EFFORT_CHOICES = [['low', '/effort low'], ['medium', '/effort medium'], ['high', '/effort high'], ['xhigh', '/effort xhigh'], ['max', '/effort max'], ['Padrão', '/effort default']];
const HELP_MENU = [['Status', '/status'], ['Nova conversa', '/new'], ['Trocar modelo', '/model'], ['Trocar esforço', '/effort'],
  ['Uso e custo', '/usage'], ['Últimas execuções', '/log'], ['Agendamentos', '/schedules'], ['Interromper tarefa', '/stop'], ['Trocar provedor', '/provider']];
const PROVIDER_CHOICES = [['Claude Code', '/provider claude'], ['Antigravity', '/provider antigravity']];
const MENU_TTL = 120000;
const menus = new Map();  // chatId -> { at, options: [command] }   numbered menu waiting for a "1", "2"...
const polls = new Map();  // poll message id (last segment) -> { chatId, options: { label: command } }
const pollKey = (id) => String(id || '').split('_').pop();

async function sendMenu(chatId, title, choices, footer) {
  menus.set(chatId, { at: Date.now(), options: choices.map((x) => x[1]) });
  const lines = choices.map((x, i) => (i + 1) + '. ' + x[0]);
  return reply(chatId, '*' + title + '*\n' + lines.join('\n') + '\n\nResponda com o número.' + (footer ? '\n\n' + footer : ''), true);
}

async function sendChoice(chatId, title, choices) {
  if (choices.length > 12) return sendMenu(chatId, title, choices); // WhatsApp polls take at most 12 options
  try {
    const r = await waha('POST', '/api/sendPoll', { session: WAHA_SESSION, chatId,
      poll: { name: title, options: choices.map((x) => x[0]), multipleAnswers: false } });
    const id = msgIdOf(r);
    if (!id) throw new Error('poll sem id');
    polls.set(pollKey(id), { chatId, options: Object.fromEntries(choices) });
    if (polls.size > 200) polls.delete(polls.keys().next().value);
    return;
  } catch (e) {
    log('poll failed, using numbered menu:', e.message);
  }
  return sendMenu(chatId, title, choices);
}

// A vote on one of our polls runs the matching command, as if it had been typed.
const seenVotes = new Set();
async function handlePollVote(payload) {
  const vote = payload && payload.vote;
  const poll = payload && payload.poll;
  if (!vote || !poll || vote.fromMe) return;
  const picked = (vote.selectedOptions || [])[0];
  if (!picked) return; // vote removed
  const entry = polls.get(pollKey(poll.id));
  if (!entry) return log('vote on unknown poll ignored');
  const voteKey = String(vote.id || '') + '|' + picked;
  if (seenVotes.has(voteKey)) return;
  seenVotes.add(voteKey); if (seenVotes.size > 2000) seenVotes.clear();
  const number = await senderNumber({ from: vote.from, participant: vote.participant, _data: vote._data });
  if (!ALLOWED.includes(number)) return log('ignored vote from non-allowed sender');
  const cmd = entry.options[picked];
  if (!cmd) return;
  log('poll vote ->', cmd);
  await command(entry.chatId, cmd);
}

// /model and /effort when this chat uses Antigravity: the options come from `agy models`, read live.
async function agyModelCommand(chatId, c, arg, isDefault) {
  if (arg && isDefault(arg)) { delete c.agyModel; delete c.agyEffort; save(); return reply(chatId, 'Modelo desta conversa (Antigravity): padrão.', true); }
  const cat = await refreshAgyCatalog(!arg);
  if (!arg) {
    if (!cat.models.length) return reply(chatId, 'Não consegui ler a lista de modelos do Antigravity (agy models). Você ainda pode usar /model <id>.', true);
    const choices = cat.models.map((g) => [g.label, '/model ' + g.base]);
    choices.push(['Padrão', '/model default']);
    return sendChoice(chatId, 'Modelo Antigravity atual: ' + agyModelLabel(c) + '. Escolha:', choices);
  }
  const g = findAgyModel(arg);
  if (!g && cat.models.length) return reply(chatId, 'Modelo não encontrado no Antigravity. Disponíveis: ' + cat.models.map((x) => x.base).join(', ') + '.', true);
  const suffix = (arg.match(EFFORT_SUFFIX) || [])[2];
  c.agyModel = g ? g.base : arg;
  if (suffix && g && g.variants[suffix.toLowerCase()]) c.agyEffort = suffix.toLowerCase();
  else if (c.agyEffort && g && Object.keys(g.variants).length && !g.variants[c.agyEffort]) delete c.agyEffort;
  save();
  const efforts = g ? await agyEfforts(g) : [];
  return reply(chatId, 'Modelo desta conversa (Antigravity): ' + agyModelLabel(c) + '.' + (efforts.length ? ' Esforços disponíveis: ' + efforts.join(', ') + ' (use /effort).' : ''), true);
}

async function agyEffortCommand(chatId, c, arg, isDefault) {
  await refreshAgyCatalog(false);
  const g = findAgyModel(c.agyModel);
  const efforts = await agyEfforts(g);
  if (!arg) {
    if (!efforts.length) return reply(chatId, 'O modelo ' + agyModelLabel(c) + ' não tem níveis de esforço ajustáveis.', true);
    return sendChoice(chatId, 'Esforço atual (' + agyModelLabel(c) + '): ' + (c.agyEffort || 'padrão') + '. Escolha:',
      [...efforts.map((e) => [e, '/effort ' + e]), ['Padrão', '/effort default']]);
  }
  if (isDefault(arg)) delete c.agyEffort;
  else if (efforts.includes(arg.toLowerCase())) c.agyEffort = arg.toLowerCase();
  else return reply(chatId, 'Nível inválido para ' + agyModelLabel(c) + '. Opções: ' + (efforts.join(', ') || 'nenhuma') + ', default.', true);
  save();
  return reply(chatId, 'Esforço desta conversa (Antigravity): ' + (c.agyEffort || 'padrão') + '.', true);
}

async function command(chatId, body) {
  const [cmdRaw, ...rest] = body.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(' ').trim();
  const c = chat(chatId);
  const isDefault = (a) => ['default', 'padrao', 'padrão', 'reset'].includes(a.toLowerCase());
  switch (cmd) {
    case '/help': return sendMenu(chatId, 'O que você quer fazer?', HELP_MENU, HELP);
    case '/new':
      delete c.session; delete c.agySession; save();
      return reply(chatId, 'Nova conversa iniciada. Modelo: ' + (c.model || defModel() || 'padrão') + '.', true);
    case '/provider': {
      const cur = PROVIDERS[providerOf(c)];
      if (!arg) return sendChoice(chatId, 'Provedor atual: ' + cur + '. Escolha:', PROVIDER_CHOICES);
      const a = arg.toLowerCase(); const want = (a === 'code' || a === 'claude') ? 'claude' : (a === 'agy' || a === 'antigravity') ? 'antigravity' : a;
      if (!PROVIDERS[want]) return reply(chatId, 'Provedor inválido. Opções: claude, antigravity.', true);
      c.provider = want; save();
      return reply(chatId, 'Provedor desta conversa: ' + PROVIDERS[want] + '. Vale a partir da próxima mensagem. Use /new para começar do zero no novo provedor.', true);
    }
    case '/model':
      if (providerOf(c) === 'antigravity') return agyModelCommand(chatId, c, arg, isDefault);
      if (!arg) return sendChoice(chatId, 'Modelo atual: ' + (c.model || defModel() || 'padrão da conta') + '. Escolha o novo:', MODEL_CHOICES);
      if (isDefault(arg)) delete c.model; else c.model = arg;
      save();
      return reply(chatId, 'Modelo desta conversa: ' + (c.model || defModel() || 'padrão da conta') + '. Vale a partir da próxima mensagem.', true);
    case '/effort':
      if (providerOf(c) === 'antigravity') return agyEffortCommand(chatId, c, arg, isDefault);
      if (!arg) return sendChoice(chatId, 'Esforço atual: ' + (c.effort || defEffort() || 'padrão') + '. Escolha o novo:', EFFORT_CHOICES);
      if (isDefault(arg)) delete c.effort;
      else if (EFFORTS.includes(arg.toLowerCase())) c.effort = arg.toLowerCase();
      else return reply(chatId, 'Nível inválido. Opções: ' + EFFORTS.join(', ') + ', default.', true);
      save();
      return reply(chatId, 'Esforço desta conversa: ' + (c.effort || defEffort() || 'padrão') + '.', true);
    case '/stop': {
      const r = running.get(chatId);
      if (!r) return reply(chatId, 'Nada em andamento.', true);
      r.child.kill('SIGTERM');
      return reply(chatId, 'Interrompido após ' + fmtDur(Date.now() - r.started) + '. A conversa continua; mande a próxima mensagem.', true);
    }
    case '/status': {
      const r = running.get(chatId);
      const q = Math.max(0, (pending.get(chatId) || 0) - (r ? 1 : 0));
      const u = c.lastUsage;
      const t = c.totals;
      return reply(chatId, [
        '*Status*',
        'Provedor: ' + PROVIDERS[providerOf(c)],
        'Sessão: ' + (((providerOf(c) === 'antigravity' ? c.agySession : c.session) || '').slice(0, 8) || 'nenhuma (próxima mensagem inicia uma)'),
        providerOf(c) === 'antigravity'
          ? 'Modelo: ' + agyModelLabel(c) + ' | Esforço: ' + (c.agyEffort || 'padrão') + ' | enviado ao agy: ' + (resolveAgyRun(c).model || 'padrão')
          : 'Modelo: ' + (c.model || defModel() || 'padrão da conta') + ' | Esforço: ' + (c.effort || defEffort() || 'padrão'),
        'Permissões: ' + PERMISSION_MODE + ' | ai-memory: ' + aiMemory.status,
        r ? 'Em andamento há ' + fmtDur(Date.now() - r.started) + ': "' + r.prompt + '"' : 'Ocioso',
        q ? 'Na fila: ' + q : '',
        u ? 'Última resposta: ' + fmtDur(u.ms || 0) + ', ' + (u.turns || 0) + ' passos' : '',
        t ? 'Total: ' + t.runs + ' execuções, ' + t.errors + ' com erro (use /usage para detalhes)' : '',
      ].filter(Boolean).join('\n'), true);
    }
    case '/usage': {
      const t = c.totals || { runs: 0, cost: 0, ms: 0, errors: 0 };
      return reply(chatId, [
        '*Uso desta conversa*',
        'Execuções: ' + t.runs + ' (com erro: ' + t.errors + ')',
        'Tempo total: ' + fmtDur(t.ms),
        'Custo estimado: USD ' + t.cost.toFixed(4),
      ].join('\n'), true);
    }
    case '/log': {
      const n = Math.min(Math.max(parseInt(arg, 10) || 5, 1), 20);
      const runs = (c.runs || []).slice(-n).reverse();
      if (!runs.length) return reply(chatId, 'Nenhuma execução nesta conversa ainda.', true);
      const lines = runs.map((r) => fmtDate(r.at) + ' · ' + (r.error ? 'erro' : 'ok') + ' · ' + fmtDur(r.ms || 0) +
        (r.cost ? ' · USD ' + r.cost.toFixed(4) : '') + '\n   "' + r.prompt + '"' +
        (r.error ? '\n   ' + String(r.error).slice(0, 200) : ''));
      return reply(chatId, '*Últimas ' + runs.length + ' execuções*\n' + lines.join('\n'), true);
    }
    case '/send': {
      const argRaw = body.trim().slice(cmdRaw.length).trim();
      const m = argRaw.match(/^(\S+@\S+|\+?\d[\d().-]*(?:\s\d[\d().-]*)*)\s+([\s\S]+)/);
      if (!m) return reply(chatId, 'Uso: /send <número> <mensagem>\nEx.: /send +55 11 99999-8888 oi, tudo bem?', true);
      try {
        const out = await sendMessage({ to: m[1], text: m[2] });
        return reply(chatId, 'Enviado para ' + out.chatId.split('@')[0] + '.', true);
      } catch (e) { return reply(chatId, 'Não enviado: ' + e.message, true); }
    }
    case '/schedules': {
      const mine = schedules.filter((s) => s.chatId === chatId);
      if (!mine.length) return reply(chatId, 'Nenhum agendamento. Peça em linguagem natural, ex.: "todo dia às 8h me mande a previsão do tempo".', true);
      return reply(chatId, '*Agendamentos* (fuso ' + TZ + ')\n' + mine.map(describe).join('\n'), true);
    }
    case '/cancel': case '/pause': case '/resume': {
      const s = schedules.find((x) => x.chatId === chatId && x.id === arg.replace('#', ''));
      if (!s) return reply(chatId, 'Agendamento não encontrado. Veja os ids com /schedules.', true);
      if (cmd === '/cancel') {
        schedules = schedules.filter((x) => x !== s); saveSched();
        audit({ action: 'schedule-delete', chatId, id: s.id });
        return reply(chatId, 'Agendamento #' + s.id + ' removido.', true);
      }
      s.paused = cmd === '/resume' ? false : !s.paused; saveSched();
      return reply(chatId, 'Agendamento #' + s.id + (s.paused ? ' pausado.' : ' ativo.'), true);
    }
    default: return null; // not a bridge command: goes to Claude (e.g. /compact or custom slash commands)
  }
}

// ---------- media ----------
async function saveMedia(msg) {
  const m = msg.media;
  if (!m || !m.url) return null;
  let u = m.url;
  try { const parsed = new URL(u); u = wahaBase() + parsed.pathname + parsed.search; } catch {}
  const res = await fetch(u, { headers: { 'X-Api-Key': WAHA_API_KEY } });
  if (!res.ok) throw new Error('download ' + res.status);
  const ext = (m.filename && path.extname(m.filename)) || '.' + String(m.mimetype || 'bin').split('/')[1].split(';')[0];
  const base = (m.filename ? path.basename(m.filename, path.extname(m.filename)) : 'arquivo').replace(/[^\w.-]+/g, '_');
  const file = path.join(INBOX, new Date().toISOString().replace(/[:.]/g, '-') + '_' + base + ext);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { file, mimetype: m.mimetype || '' };
}

// ---------- message handling ----------
const seen = new Set();
async function handleMessage(msg) {
  if (!msg || msg.fromMe) return;
  const chatId = msg.from;
  if (!chatId || chatId.endsWith('@g.us') || chatId.endsWith('@newsletter') || chatId === 'status@broadcast') return;
  if (msg.id && seen.has(msg.id)) return;
  if (msg.id) { seen.add(msg.id); if (seen.size > 5000) seen.clear(); }

  const number = await senderNumber(msg);
  if (!ALLOWED.length || !ALLOWED.includes(number)) {
    log('ignored message from non-allowed sender', number || chatId);
    return;
  }
  waha('POST', '/api/sendSeen', { session: WAHA_SESSION, chatId }).catch(() => {});
  let body = String(msg.body || '').trim();

  // A bare number answers a numbered menu sent in the last 2 minutes; anything else cancels the menu.
  const menu = menus.get(chatId);
  if (menu) {
    menus.delete(chatId);
    const n = body.length <= 2 && /^\d+(?![\s\S])/.test(body) ? Number(body) : 0;
    if (Date.now() - menu.at < MENU_TTL && n >= 1 && n <= menu.options.length) body = menu.options[n - 1];
  }

  if (body.startsWith('/')) {
    const handled = await command(chatId, body);
    if (handled !== null) return;
  }

  if (msg.hasMedia) {
    try {
      const saved = await saveMedia(msg);
      if (!saved) {
        await reply(chatId, 'Recebi um arquivo, mas o WAHA não disponibilizou o download (no WAHA Core isso pode exigir a versão Plus).', true);
        if (!body) return;
      } else {
        const kind = saved.mimetype.startsWith('image/') ? 'uma imagem' : saved.mimetype.startsWith('audio/') ? 'um áudio' : 'um arquivo';
        body = '[O usuário enviou ' + kind + ' (' + saved.mimetype + ') salvo em ' + saved.file + ']' + (body ? '\n\n' + body : '\n\nAnalise o conteúdo e responda.');
      }
    } catch (e) {
      log('media error', e.message);
      await reply(chatId, 'Não consegui baixar o arquivo: ' + e.message, true);
      if (!body) return;
    }
  }
  if (!body) return;

  if (running.has(chatId)) {
    const q = pending.get(chatId) || 1;
    reply(chatId, 'Ainda estou trabalhando na mensagem anterior. Esta entrou na fila (' + q + ' à frente). Use /stop para interromper.', true).catch(() => {});
  }

  enqueue(chatId, async () => {
    const c = chat(chatId);
    log('prompt from', number, body.length, 'chars');
    const typing = () => waha('POST', '/api/startTyping', { session: WAHA_SESSION, chatId }).catch(() => {});
    typing();
    const keepTyping = setInterval(typing, 20000);
    const agy = providerOf(c) === 'antigravity';
    const opts = { model: c.model || defModel(), effort: c.effort || defEffort(), resume: agy ? c.agySession : c.session };
    const started = Date.now();
    const status = liveStatus(chatId);
    const onActivity = (label) => status.activity(label);
    let r = await runAgent(chatId, body, opts, onActivity);
    // Retry from a fresh session only when resuming the old one failed. Not on timeouts or user stops:
    // re-running a timed-out task from scratch would run it twice and could repeat side effects.
    if (r.error && opts.resume && !r.stopped && !r.timedOut) {
      log('resume failed, starting fresh:', r.error);
      if (agy) delete c.agySession; else delete c.session;
      r = await runAgent(chatId, body, { ...opts, resume: undefined }, onActivity);
    }
    clearInterval(keepTyping);
    waha('POST', '/api/stopTyping', { session: WAHA_SESSION, chatId }).catch(() => {});
    await status.finish();
    if (r.stopped) {
      recordRun(chatId, { prompt: body.slice(0, 80), ms: Date.now() - started, error: 'interrompido pelo usuário' });
      return;
    }
    if (r.sessionId) { if (agy) c.agySession = r.sessionId; else c.session = r.sessionId; }
    if (r.usage) c.lastUsage = r.usage;
    recordRun(chatId, { prompt: body.slice(0, 80), ms: r.usage ? r.usage.ms : Date.now() - started,
      cost: r.usage ? r.usage.cost : 0, error: r.error });
    save();
    await reply(chatId, r.error ? 'Erro ao executar ' + PROVIDERS[agy ? 'antigravity' : 'claude'] + ': ' + r.error : r.text, Boolean(r.error));
  });
}

// ---------- schedules ----------
const SCHED_FILE = path.join(DATA_DIR, 'schedules.json');
let schedules = [];
try { schedules = JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8')); } catch {}
const saveSched = () => fs.writeFileSync(SCHED_FILE, JSON.stringify(schedules, null, 2));
const DOWS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function tzParts(d) {
  const o = {};
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  for (const p of fmt.formatToParts(d)) o[p.type] = p.value;
  return { min: Number(o.minute), hour: Number(o.hour) % 24, dom: Number(o.day), mon: Number(o.month), dow: DOWS[o.weekday],
    key: o.year + '-' + o.month + '-' + o.day + ' ' + o.hour + ':' + o.minute };
}
function fieldOk(expr, v, min, max) {
  return expr.split(',').some((part) => {
    const [r, s] = part.split('/');
    const step = s ? Number(s) : 1;
    let lo, hi;
    if (r === '*') { lo = min; hi = max; }
    else if (r.includes('-')) { [lo, hi] = r.split('-').map(Number); }
    else { lo = Number(r); hi = s ? max : lo; }
    return v >= lo && v <= hi && (v - lo) % step === 0;
  });
}
function validCron(c) {
  const f = String(c || '').trim().split(/\s+/);
  if (f.length !== 5) return false;
  const lim = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return f.every((x, i) => x.split(',').every((part) => {
    const [r, s] = part.split('/');
    if (s !== undefined && !(Number(s) > 0)) return false;
    if (r === '*') return true;
    const [a, b] = r.split('-');
    const na = Number(a), nb = b === undefined ? na : Number(b);
    return Number.isInteger(na) && Number.isInteger(nb) && na >= lim[i][0] && nb <= lim[i][1] && na <= nb;
  }));
}
function cronMatch(c, t) {
  const [mi, h, dom, mon, dow] = c.trim().split(/\s+/);
  if (!fieldOk(mi, t.min, 0, 59) || !fieldOk(h, t.hour, 0, 23) || !fieldOk(mon, t.mon, 1, 12)) return false;
  const dOk = fieldOk(dom, t.dom, 1, 31);
  const wOk = fieldOk(dow, t.dow, 0, 7) || (t.dow === 0 && fieldOk(dow, 7, 0, 7));
  if (dom !== '*' && dow !== '*') return dOk || wOk; // standard cron: either day field may match
  return dOk && wOk;
}
function addSchedule(b) {
  if (!b.chatId || !chats[b.chatId]) throw new Error('chatId desconhecido');
  if (!b.prompt) throw new Error('prompt obrigatório');
  const s = { id: crypto.randomBytes(3).toString('hex'), chatId: b.chatId, prompt: String(b.prompt),
    description: String(b.description || b.prompt).slice(0, 120), created: new Date().toISOString() };
  if (b.cron) {
    if (!validCron(b.cron)) throw new Error('cron inválido: use 5 campos (minuto hora dia mês dia-da-semana), no fuso ' + TZ);
    s.cron = String(b.cron).trim();
  } else if (b.at) {
    const t = new Date(b.at);
    if (isNaN(t)) throw new Error('at inválido: use ISO 8601 com fuso, ex. 2026-11-10T08:00:00-03:00');
    if (t.getTime() < Date.now() - 60000) throw new Error('at está no passado');
    s.at = t.toISOString();
  } else throw new Error('informe cron (recorrente) ou at (uma vez)');
  schedules.push(s); saveSched();
  audit({ action: 'schedule-add', chatId: s.chatId, id: s.id, cron: s.cron || null, at: s.at || null, description: s.description });
  return s;
}
const fmtDate = (iso) => new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
const describe = (s) => '#' + s.id + (s.paused ? ' (pausado)' : '') + ' · ' + (s.cron ? 'cron ' + s.cron : 'uma vez em ' + fmtDate(s.at)) +
  '\n   ' + s.description + (s.lastRun ? '\n   última execução: ' + fmtDate(s.lastRun) : '');

function runSchedule(s) {
  enqueue(s.chatId, async () => {
    const c = chat(s.chatId);
    log('running schedule', s.id);
    const prompt = '[Tarefa agendada #' + s.id + ': ' + s.description + ']\n' +
      'Execute agora. Sua resposta final será enviada ao usuário pelo WhatsApp como a mensagem desta tarefa.\n\n' + s.prompt;
    const started = Date.now();
    const r = await runAgent(s.chatId, prompt, { model: c.model || defModel(), effort: c.effort || defEffort() });
    if (r.stopped) return;
    recordRun(s.chatId, { prompt: '[agendamento #' + s.id + '] ' + s.description.slice(0, 60),
      ms: r.usage ? r.usage.ms : Date.now() - started, cost: r.usage ? r.usage.cost : 0, error: r.error });
    await reply(s.chatId, r.error ? '⏰ Falha na tarefa agendada #' + s.id + ': ' + r.error : '⏰ ' + r.text, Boolean(r.error));
  });
}
let lastMinute = '';
function tick() {
  const now = new Date();
  const t = tzParts(now);
  const newMinute = t.key !== lastMinute;
  lastMinute = t.key;
  let changed = false;
  for (const s of [...schedules]) {
    if (s.paused) continue;
    if (s.cron && s.lastRun && tzParts(new Date(s.lastRun)).key === t.key) continue; // already ran this minute (e.g. restart)
    const due = s.cron ? newMinute && cronMatch(s.cron, t) : new Date(s.at) <= now;
    if (!due) continue;
    s.lastRun = now.toISOString(); changed = true;
    if (s.at) schedules = schedules.filter((x) => x !== s);
    runSchedule(s);
  }
  if (changed) saveSched();
}
setInterval(tick, Number(env.SCHEDULER_TICK_MS || 15000));

// ---------- send to any number (local only, used by Claude itself) ----------
// "to" may be a phone number in any format (+55 11 9...), or a full WhatsApp id (...@c.us / ...@g.us / ...@lid).
async function resolveTo(to) {
  to = String(to || '').trim();
  if (to.includes('@')) return to;
  const digits = to.replace(/\D/g, '');
  if (digits.length < 10) throw new Error('número inválido (use DDI+DDD+número, ex. 5511999998888)');
  try {
    const r = await waha('GET', '/api/contacts/check-exists?session=' + encodeURIComponent(WAHA_SESSION) + '&phone=' + digits);
    if (r && r.numberExists === false) throw new Error('o número ' + digits + ' não tem WhatsApp');
    if (r && r.chatId) return r.chatId;
  } catch (e) {
    if (e.message.includes('não tem WhatsApp')) throw e;
    log('check-exists failed, using raw number', e.message);
  }
  return digits + '@c.us';
}

async function sendMessage(reqBody) {
  const { to, text } = reqBody;
  if (!text || !String(text).trim()) throw new Error('texto vazio');
  const chatId = await resolveTo(to);
  for (const part of chunks(reqBody.raw ? String(text) : toWhatsApp(String(text)))) {
    await waha('POST', '/api/sendText', { session: WAHA_SESSION, chatId, text: part });
  }
  log('sent message to', chatId);
  audit({ action: 'send', to: chatId, chars: String(text).length, preview: String(text).slice(0, 80) });
  return { sent: true, chatId };
}

// ---------- send-file (local only, used by Claude itself) ----------
async function sendFile(reqBody) {
  const { path: p, caption } = reqBody;
  let chatId = reqBody.chatId;
  if (reqBody.to) chatId = await resolveTo(reqBody.to);
  else if (!chatId || !chats[chatId]) throw new Error('chatId desconhecido');
  const abs = path.resolve(WORKDIR, p);
  const data = fs.readFileSync(abs).toString('base64');
  const ext = path.extname(abs).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const mimetype = types[ext] || 'application/octet-stream';
  const file = { mimetype, filename: path.basename(abs), data };
  const endpoint = mimetype.startsWith('image/') ? '/api/sendImage' : '/api/sendFile';
  const result = await waha('POST', endpoint, { session: WAHA_SESSION, chatId, file, caption: caption || undefined });
  audit({ action: 'send-file', to: chatId, file: abs, bytes: fs.statSync(abs).size, caption: caption || null });
  return result;
}

// ---------- web chat (conversations started from the Agent Control panel) ----------
const WEB_DIR = path.join(DATA_DIR, 'web');
fs.mkdirSync(WEB_DIR, { recursive: true });
const webFile = (chatId) => path.join(WEB_DIR, String(chatId).slice(4).replace(/[^a-f0-9]/g, '') + '.json');
const webListeners = new Map(); // chatId -> Set(fn(event))
function webHistory(chatId) {
  try { return JSON.parse(fs.readFileSync(webFile(chatId), 'utf8')); } catch { return []; }
}
function webEmit(chatId, ev) {
  for (const fn of webListeners.get(chatId) || []) { try { fn(ev); } catch {} }
}
function webAppend(chatId, msg) {
  const m = { id: crypto.randomBytes(4).toString('hex'), at: new Date().toISOString(), ...msg };
  const h = webHistory(chatId);
  h.push(m);
  fs.writeFileSync(webFile(chatId), JSON.stringify(h.slice(-500)));
  webEmit(chatId, { type: 'message', message: m });
  return m;
}
const clip = (s, n) => { s = typeof s === 'string' ? s : JSON.stringify(s); return s && s.length > n ? s.slice(0, n) + '…' : (s || ''); };

// Turns Claude Code stream-json events into small events for the panel: text, tool calls, tool results.
function webEventsFrom(ev, tools) {
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') {
    out.push({ type: 'init', model: ev.model, mcp: (ev.mcp_servers || []).map((s) => ({ name: s.name, status: s.status })) });
  }
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type === 'text' && b.text) out.push({ type: 'text', text: b.text });
      if (b.type === 'tool_use') {
        const t = { id: b.id, name: b.name, input: clip(b.input, 600) };
        tools.push(t);
        out.push({ type: 'tool', ...t });
      }
    }
  }
  if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const b of ev.message.content) {
      if (b.type !== 'tool_result') continue;
      const text = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : b.content;
      const t = tools.find((x) => x.id === b.tool_use_id);
      if (t) { t.result = clip(text, 800); t.isError = Boolean(b.is_error); }
      out.push({ type: 'tool_result', id: b.tool_use_id, text: clip(text, 800), isError: Boolean(b.is_error) });
    }
  }
  return out;
}

// Files sent from the web chat: saved in INBOX like WhatsApp media, and the path goes to the agent.
const WEB_MAX_FILE = 25 * 1024 * 1024;
function saveWebFiles(files) {
  const out = [];
  for (const f of Array.isArray(files) ? files.slice(0, 10) : []) {
    const buf = Buffer.from(String(f.data || ''), 'base64');
    if (!buf.length) continue;
    if (buf.length > WEB_MAX_FILE) throw new Error('arquivo grande demais (máx. 25 MB): ' + f.name);
    const type = String(f.type || 'application/octet-stream').slice(0, 100);
    const ext = path.extname(String(f.name || '')) || '.' + (type.split('/')[1] || 'bin').split(';')[0];
    const base = path.basename(String(f.name || 'arquivo'), path.extname(String(f.name || ''))).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'arquivo';
    const name = 'web-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(2).toString('hex') + '_' + base + ext.replace(/[^\w.]/g, '');
    fs.writeFileSync(path.join(INBOX, name), buf);
    out.push({ name: String(f.name || name).slice(0, 120), type, size: buf.length, file: name, voice: Boolean(f.voice) });
  }
  return out;
}
function promptWithFiles(text, files, transcript) {
  if (!files.length) return text;
  const notes = files.map((f) => {
    const kind = f.voice ? 'uma mensagem de voz' : f.type.startsWith('image/') ? 'uma imagem' : f.type.startsWith('audio/') ? 'um áudio' : f.type.startsWith('video/') ? 'um vídeo' : 'um arquivo';
    return '[O usuário enviou ' + kind + ' (' + f.type + ', ' + f.name + ') salvo em ' + path.join(INBOX, f.file) + ']';
  });
  if (transcript) notes.push('[Transcrição automática da mensagem de voz, feita no navegador: ' + transcript + ']');
  return notes.join('\n') + '\n\n' + (text || (transcript ? 'Responda à mensagem de voz.' : 'Analise o conteúdo e responda.'));
}

function webSend(chatId, text, files = [], transcript = '') {
  const c = chat(chatId);
  webAppend(chatId, { role: 'user', text, ...(files.length ? { files } : {}), ...(transcript ? { transcript } : {}) });
  const label = text || transcript || (files[0] && (files[0].voice ? 'Mensagem de voz' : files[0].name)) || '';
  if (!c.title || c.title === 'Nova conversa') { c.title = label.replace(/\s+/g, ' ').slice(0, 60); save(); }
  const prompt = promptWithFiles(text, files, transcript);
  enqueue(chatId, async () => {
    const agy = providerOf(c) === 'antigravity';
    const opts = { model: c.model || defModel(), effort: c.effort || defEffort(), resume: agy ? c.agySession : c.session };
    webEmit(chatId, { type: 'start', provider: providerOf(c) });
    const tools = [];
    const onEvent = (ev) => { for (const e of webEventsFrom(ev, tools)) webEmit(chatId, e); };
    const started = Date.now();
    let r = await runAgent(chatId, prompt, opts, null, onEvent);
    if (r.error && opts.resume && !r.stopped && !r.timedOut) {
      log('web: resume failed, starting fresh:', r.error);
      if (agy) delete c.agySession; else delete c.session;
      webEmit(chatId, { type: 'text', text: '(a sessão anterior não abriu; começando uma nova)' });
      r = await runAgent(chatId, prompt, { ...opts, resume: undefined }, null, onEvent);
    }
    if (r.sessionId) { if (agy) c.agySession = r.sessionId; else c.session = r.sessionId; }
    if (r.usage) c.lastUsage = r.usage;
    const ms = r.usage ? r.usage.ms : Date.now() - started;
    recordRun(chatId, { prompt: label.slice(0, 80), ms, cost: r.usage ? r.usage.cost : 0, error: r.stopped ? 'interrompido pelo usuário' : r.error });
    webAppend(chatId, {
      role: 'assistant', provider: providerOf(c), tools,
      text: r.stopped ? '(interrompido)' : r.error ? 'Erro: ' + r.error : r.text,
      error: Boolean(r.error), stopped: Boolean(r.stopped),
      usage: { ms, cost: r.usage ? r.usage.cost : 0, turns: r.usage ? r.usage.turns : 0 },
    });
    webEmit(chatId, { type: 'idle' });
  });
}

// ---------- usage: plan limits (Claude, Antigravity) and daily history for the panel ----------
// Every run appends one line to usage.jsonl. Claude's history before that file existed is rebuilt from
// Claude Code's own transcripts (~/.claude/projects/**/*.jsonl), which carry token counts per message.
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl');
function logUsage(provider, chatId, cost, ms, u) {
  try {
    u = u || {};
    const line = { at: new Date().toISOString(), provider, web: isWeb(chatId), cost: cost || 0, ms: ms || 0,
      in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: (u.output_tokens || 0) + (u.thinking_tokens || 0),
      cacheRead: u.cache_read_input_tokens || u.cache_read_tokens || 0 };
    fs.appendFileSync(USAGE_FILE, JSON.stringify(line) + '\n');
  } catch (e) { log('usage log failed', e.message); }
}
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const HOME_DIR = env.HOME || '/tmp';
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

const usageCache = { claude: null, agy: null, agyProject: null };
async function claudeLimits() {
  const c = usageCache.claude;
  if (c && Date.now() - c.t < 60000) return c.v;
  const cred = readJson(path.join(HOME_DIR, '.claude', '.credentials.json'))?.claudeAiOauth;
  let v;
  try {
    if (!cred?.accessToken) throw new Error('Claude Code sem login OAuth');
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', { signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + cred.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 401 ? ' (token vencido: renova na próxima execução do Claude)' : ''));
    const j = await r.json();
    const lim = (k, x) => x && { kind: k, percent: x.utilization ?? null, resetsAt: x.resets_at || null };
    v = { plan: cred.subscriptionType || null, limits: [lim('session', j.five_hour), lim('weekly', j.seven_day), lim('weekly_opus', j.seven_day_opus), lim('weekly_sonnet', j.seven_day_sonnet)].filter(Boolean),
      extra: j.extra_usage?.is_enabled ? { used: j.extra_usage.used_credits, limit: j.extra_usage.monthly_limit } : null };
  } catch (e) {
    v = { ...(c?.v?.limits ? c.v : {}), error: e.message, stale: Boolean(c?.v?.limits) };
  }
  usageCache.claude = { t: Date.now(), v };
  return v;
}

async function agyLimits() {
  const c = usageCache.agy;
  if (c && Date.now() - c.t < 60000) return c.v;
  let v;
  try {
    const tok = readJson(path.join(HOME_DIR, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))?.token?.access_token;
    if (!tok) throw new Error('Antigravity sem login');
    const call = async (method, body) => {
      const r = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:' + method, { method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', 'User-Agent': 'antigravity' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(method + ': HTTP ' + r.status + (r.status === 401 ? ' (token vencido: renova na próxima execução do agy)' : ''));
      return r.json();
    };
    if (!usageCache.agyProject) {
      const la = await call('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } });
      usageCache.agyProject = { id: la.cloudaicompanionProject, tier: la.paidTier?.name || la.currentTier?.name || null };
    }
    const fm = await call('fetchAvailableModels', usageCache.agyProject.id ? { project: usageCache.agyProject.id } : {});
    // Models share quota pools: group them by (remaining, reset time).
    const groups = new Map();
    for (const [id, m] of Object.entries(fm.models || {})) {
      const q = m.quotaInfo;
      if (!q || !q.resetTime || /^(tab_|chat_)/.test(id)) continue;
      const key = (q.remainingFraction ?? 1) + '|' + q.resetTime;
      if (!groups.has(key)) groups.set(key, { remaining: q.remainingFraction ?? 1, resetsAt: q.resetTime, models: [] });
      groups.get(key).models.push(m.displayName || id);
    }
    const label = (g) => {
      const t = g.models.join(' ').toLowerCase();
      const fam = ['gemini', 'claude', 'gpt'].filter((f) => t.includes(f));
      return fam.map((f) => (f === 'gpt' ? 'GPT' : f[0].toUpperCase() + f.slice(1))).join(' + ') || 'Modelos';
    };
    v = { tier: usageCache.agyProject.tier, groups: [...groups.values()].map((g) => ({ label: label(g), percent: Math.round((1 - g.remaining) * 1000) / 10, resetsAt: g.resetsAt, models: [...new Set(g.models)].sort() }))
      .sort((a, b) => a.label.localeCompare(b.label)) };
  } catch (e) {
    v = { ...(c?.v?.groups ? c.v : {}), error: e.message, stale: Boolean(c?.v?.groups) };
  }
  usageCache.agy = { t: Date.now(), v };
  return v;
}

// Claude Code transcripts, parsed once per file version (size + mtime).
const transcriptCache = new Map();
function claudeTranscriptDays() {
  const root = path.join(HOME_DIR, '.claude', 'projects');
  const files = [];
  const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch {} for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.jsonl')) files.push(f); } };
  walk(root);
  const days = {};
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    const sig = st.size + ':' + st.mtimeMs;
    let c = transcriptCache.get(f);
    if (!c || c.sig !== sig) {
      const per = {}, seen = new Set();
      let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch {}
      for (const line of text.split('\n')) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const msg = j.message, u = msg?.usage;
        if (j.type !== 'assistant' || !u || !j.timestamp || (msg.id && seen.has(msg.id))) continue;
        if (msg.id) seen.add(msg.id);
        if (msg.model === '<synthetic>') continue;
        const d = (per[dayKey(j.timestamp)] ||= { in: 0, out: 0, cacheRead: 0, msgs: 0 });
        d.in += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0); d.out += u.output_tokens || 0; d.cacheRead += u.cache_read_input_tokens || 0; d.msgs += 1;
      }
      c = { sig, per }; transcriptCache.set(f, c);
    }
    for (const [k, d] of Object.entries(c.per)) { const t = (days[k] ||= { in: 0, out: 0, cacheRead: 0, msgs: 0 }); t.in += d.in; t.out += d.out; t.cacheRead += d.cacheRead; t.msgs += d.msgs; }
  }
  return days;
}

async function usageReport(nDays = 56) {
  const [claude, antigravity] = await Promise.all([claudeLimits(), agyLimits()]);
  const tdays = claudeTranscriptDays();
  const log = {};
  try {
    for (const line of fs.readFileSync(USAGE_FILE, 'utf8').split('\n')) {
      if (!line) continue; let j; try { j = JSON.parse(line); } catch { continue; }
      const d = ((log[dayKey(j.at)] ||= {})[j.provider] ||= { runs: 0, cost: 0, ms: 0, in: 0, out: 0, cacheRead: 0 });
      d.runs += 1; d.cost += j.cost || 0; d.ms += j.ms || 0; d.in += j.in || 0; d.out += j.out || 0; d.cacheRead += j.cacheRead || 0;
    }
  } catch {}
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const date = dayKey(Date.now() - i * 86400000);
    const tc = tdays[date], lc = log[date]?.claude, la = log[date]?.antigravity;
    days.push({ date,
      claude: { tokens: tc ? tc.in + tc.out : (lc ? lc.in + lc.out : 0), out: tc?.out || lc?.out || 0, cacheRead: tc?.cacheRead || lc?.cacheRead || 0, msgs: tc?.msgs || 0, runs: lc?.runs || 0, cost: lc?.cost || 0 },
      antigravity: { tokens: la ? la.in + la.out : 0, out: la?.out || 0, cacheRead: la?.cacheRead || 0, runs: la?.runs || 0 } });
  }
  return { claude, antigravity, days, tz: TZ, historySince: { antigravity: fs.existsSync(USAGE_FILE) ? (fs.readFileSync(USAGE_FILE, 'utf8').slice(0, 40).match(/"at":"([^"]+)/) || [])[1] || null : null } };
}

// ---------- memory explorer: ai-memory wiki pages + Claude Code's own memory files ----------
// Reads go through ai-memory's REST API (/api/v1, read-only); writes and deletes through its CLI, which
// indexes and versions the change (memory_restore_page can undo). Local memory lives in MEMORY_DIR as one
// .md per fact plus the MEMORY.md index.
const aiMemToken = () => { try { return fs.readFileSync(path.join(HOME_DIR, '.local', 'share', 'ai-memory', 'auth-token'), 'utf8').trim(); } catch { return ''; } };
async function aiMemGet(p) {
  const r = await fetch(AI_MEMORY_URL + '/api/v1' + p, { signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + aiMemToken() } });
  if (!r.ok) throw new Error('ai-memory ' + p + ': HTTP ' + r.status);
  return r.json();
}
const memScope = (ws, proj) => '/workspaces/' + encodeURIComponent(ws || 'default') + '/projects/' + encodeURIComponent(proj);
const safePagePath = (p) => { p = String(p || ''); if (!/^[\w\-./]+\.md$/.test(p) || p.includes('..') || p.startsWith('/')) throw new Error('caminho inválido'); return p; };

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {}; let cur = null;
  for (const line of m[1].split('\n')) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) { cur = kv[1]; meta[cur] = kv[2].replace(/^["']|["']$/g, ''); continue; }
    const sub = /^\s+(\w[\w-]*):\s*(.*)$/.exec(line);
    if (sub && cur) { if (typeof meta[cur] !== 'object') meta[cur] = {}; meta[cur][sub[1]] = sub[2]; }
  }
  return { meta, body: text.slice(m[0].length) };
}
const localMemFile = (name) => { const n = String(name || '').replace(/\.md$/, ''); if (!/^[\w\-.]+$/.test(n) || n === 'MEMORY' || n.startsWith('.')) throw new Error('nome inválido'); return path.join(MEMORY_DIR, n + '.md'); };
function localMemList() {
  let files = []; try { files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md'); } catch {}
  const index = (() => { try { return fs.readFileSync(path.join(MEMORY_DIR, 'MEMORY.md'), 'utf8'); } catch { return ''; } })();
  return files.map((f) => {
    const full = path.join(MEMORY_DIR, f); const text = fs.readFileSync(full, 'utf8'); const st = fs.statSync(full);
    const { meta, body } = parseFrontmatter(text);
    return { file: f, name: meta.name || f.replace(/\.md$/, ''), description: meta.description || '', type: (meta.metadata && meta.metadata.type) || meta.type || '',
      updated_at: st.mtime.toISOString(), size: st.size, indexed: index.includes('(' + f + ')'), body, raw: text };
  }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
function localMemWrite({ file, name, description, type, body, raw, title }) {
  const f = localMemFile(file || name);
  const slug = path.basename(f, '.md');
  const text = raw != null ? String(raw) : '---\nname: ' + (name || slug) + '\ndescription: ' + String(description || '').replace(/\n/g, ' ') + '\nmetadata:\n  type: ' + (type || 'project') + '\n---\n\n' + String(body || '').trim() + '\n';
  fs.writeFileSync(f, text);
  const idx = path.join(MEMORY_DIR, 'MEMORY.md');
  let index = ''; try { index = fs.readFileSync(idx, 'utf8'); } catch {}
  if (!index.includes('(' + slug + '.md)')) fs.writeFileSync(idx, index.replace(/\n*$/, '\n') + '- [' + (title || name || slug) + '](' + slug + '.md) — ' + String(description || '').replace(/\n/g, ' ') + '\n');
  return slug + '.md';
}
function localMemDelete(file) {
  const f = localMemFile(file);
  const slug = path.basename(f);
  fs.mkdirSync(path.join(DATA_DIR, 'memory-trash'), { recursive: true });
  fs.renameSync(f, path.join(DATA_DIR, 'memory-trash', Date.now() + '-' + slug)); // recoverable
  const idx = path.join(MEMORY_DIR, 'MEMORY.md');
  try { fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').split('\n').filter((l) => !l.includes('(' + slug + ')')).join('\n')); } catch {}
}

// ---------- admin API for the Agent Control panel ----------
// Reached over the private coolify network at http://claude-bridge-claude-zap:3000/admin/...
// Every call needs "Authorization: Bearer <BRIDGE_ADMIN_TOKEN>". Without that variable the API is off.
const ADMIN_TOKEN = env.BRIDGE_ADMIN_TOKEN || '';
const CLAUDE_MODELS = [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }, { id: 'fable', label: 'Fable' }];

function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(ADMIN_TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function execCmd(bin, args, ms = 60000) {
  const isScript = bin.endsWith('.mjs') || bin.endsWith('.js');
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn(isScript ? process.execPath : bin, isScript ? [bin, ...args] : args, { cwd: WORKDIR, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const timer = setTimeout(() => child.kill('SIGTERM'), ms);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: stripAnsi(out), err: stripAnsi(err) }); });
  });
}

let versionCache = { at: 0, claude: '', agy: '' };
async function providersInfo() {
  if (Date.now() - versionCache.at > 10 * 60 * 1000) {
    const cl = await execCmd(CLAUDE_BIN, ['--version'], 20000);
    const ag = fs.existsSync(AGY_BIN) ? await execCmd(AGY_BIN, ['--version'], 20000) : null;
    versionCache = { at: Date.now(), claude: cl.code === 0 ? cl.out.trim() : '', agy: ag && ag.code === 0 ? ag.out.trim() : '' };
  }
  const agyInstalled = fs.existsSync(AGY_BIN);
  const cat = agyInstalled ? await refreshAgyCatalog(false) : { models: [] };
  return {
    defaultProvider: settings.defaultProvider || 'claude',
    providers: [
      { id: 'claude', name: PROVIDERS.claude, installed: Boolean(versionCache.claude), version: versionCache.claude,
        auth: env.CLAUDE_CODE_OAUTH_TOKEN ? 'Assinatura (CLAUDE_CODE_OAUTH_TOKEN)' : env.ANTHROPIC_API_KEY ? 'API key (ANTHROPIC_API_KEY)' : 'sem credencial',
        authKind: env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth' : env.ANTHROPIC_API_KEY ? 'apikey' : 'none',
        models: CLAUDE_MODELS, efforts: EFFORTS, defaultModel: defModel(), defaultEffort: defEffort(),
        envModel: ENV_MODEL, envEffort: ENV_EFFORT, permissionMode: PERMISSION_MODE },
      { id: 'antigravity', name: PROVIDERS.antigravity, installed: agyInstalled, version: versionCache.agy,
        models: cat.models.map((g) => ({ id: g.base, label: g.label, efforts: g.efforts })) },
    ],
  };
}

function chatView(id) {
  const c = chats[id] || {};
  const r = running.get(id);
  return {
    id, kind: isWeb(id) ? 'web' : 'whatsapp', title: c.title || (isWeb(id) ? 'Conversa web' : id.split('@')[0]),
    provider: providerOf(c), providerSet: Boolean(c.provider),
    model: c.model || '', effort: c.effort || '', agyModel: c.agyModel || '', agyEffort: c.agyEffort || '',
    session: c.session || '', agySession: c.agySession || '', created: c.created || '',
    totals: c.totals || { runs: 0, cost: 0, ms: 0, errors: 0 }, runs: c.runs || [], lastUsage: c.lastUsage || null,
    running: r ? { started: r.started, prompt: r.prompt } : null,
    queued: Math.max(0, (pending.get(id) || 0) - (r ? 1 : 0)),
  };
}

// Claude MCP servers: user scope and local scope live in ~/.claude.json; project scope in WORKDIR/.mcp.json.
function claudeMcpConfig() {
  const out = { user: {}, local: {}, project: {} };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(env.HOME || '/tmp', '.claude.json'), 'utf8'));
    out.user = j.mcpServers || {};
    out.local = (j.projects && j.projects[WORKDIR] && j.projects[WORKDIR].mcpServers) || {};
  } catch {}
  try { out.project = JSON.parse(fs.readFileSync(path.join(WORKDIR, '.mcp.json'), 'utf8')).mcpServers || {}; } catch {}
  return out;
}

// agy 1.5+ keeps its MCP servers in ~/.gemini/config/mcp_config.json; the other paths are older layouts.
const AGY_MCP_FILES = ['.gemini/config/mcp_config.json', '.gemini/antigravity/mcp_config.json', '.antigravity/mcp_config.json', '.antigravity/mcp.json', '.config/antigravity/mcp.json'];
function agyMcpConfig() {
  for (const f of AGY_MCP_FILES) {
    const p = path.join(env.HOME || '/tmp', f);
    try { return { config: JSON.parse(fs.readFileSync(p, 'utf8')), configPath: p }; } catch {}
  }
  return { config: null, configPath: '' };
}
// The panel only needs to see which headers/env vars exist, never their values (tokens).
function redactMcp(cfg) {
  const mask = (o) => Object.fromEntries(Object.keys(o || {}).map((k) => [k, '***']));
  const out = { ...cfg };
  if (cfg.headers) out.headers = mask(cfg.headers);
  if (cfg.env) out.env = mask(cfg.env);
  return out;
}
const redactServers = (servers) => Object.fromEntries(Object.entries(servers || {}).map(([n, c]) => [n, redactMcp(c || {})]));
async function agyMcp() {
  if (!fs.existsSync(AGY_BIN)) return { installed: false };
  const r = await execCmd(AGY_BIN, ['mcp', 'list'], 30000);
  const { config, configPath } = agyMcpConfig();
  const servers = redactServers(config && config.mcpServers);
  return { installed: true, list: (r.out + (r.code ? '\n' + r.err : '')).trim(), config: config ? { ...config, mcpServers: servers } : null, configPath, servers };
}

// agy has no health check (`agy mcp list` only says enabled/disabled), so the bridge does the MCP
// handshake itself: spawn the stdio command (or POST to the URL) and wait for the initialize answer.
const MCP_INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-control', version: '1' } } };
function probeStdio(cfg, ms) {
  return new Promise((resolve) => {
    let child, buf = '', errBuf = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child && child.kill('SIGTERM'); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'sem resposta em ' + Math.round(ms / 1000) + 's' + (errBuf.trim() ? ': ' + errBuf.trim().split('\n').pop() : '') }), ms);
    try { child = spawn(cfg.command, cfg.args || [], { cwd: WORKDIR, env: { ...env, ...(cfg.env || {}) }, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return finish({ ok: false, error: e.message }); }
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => finish({ ok: false, error: 'processo saiu (código ' + code + ')' + (errBuf.trim() ? ': ' + errBuf.trim().split('\n').pop() : '') }));
    child.stderr.on('data', (d) => { errBuf = (errBuf + d).slice(-2000); });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        try {
          const j = JSON.parse(line);
          if (j.id === 1) finish(j.error ? { ok: false, error: j.error.message || 'erro no initialize' } : { ok: true, server: j.result && j.result.serverInfo });
        } catch {}
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(MCP_INIT) + '\n');
  });
}
async function probeHttp(cfg, ms) {
  try {
    const r = await fetch(cfg.serverUrl || cfg.url, {
      method: 'POST', signal: AbortSignal.timeout(ms),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(cfg.headers || {}) },
      body: JSON.stringify(MCP_INIT),
    });
    const text = await r.text();
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + (r.status === 401 || r.status === 403 ? ' (precisa de autenticação)' : '') };
    const m = text.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    return j.error ? { ok: false, error: j.error.message || 'erro no initialize' } : { ok: true, server: j.result && j.result.serverInfo };
  } catch (e) { return { ok: false, error: e.name === 'TimeoutError' ? 'sem resposta em ' + Math.round(ms / 1000) + 's' : e.message }; }
}
async function agyMcpStatus() {
  if (!fs.existsSync(AGY_BIN)) return { output: 'agy não está instalado', code: 1, servers: {} };
  const { config } = agyMcpConfig();
  const entries = Object.entries((config && config.mcpServers) || {});
  const results = await Promise.all(entries.map(async ([n, cfg]) => {
    if (cfg.disabled) return [n, { ok: false, disabled: true, status: 'Disabled' }];
    const r = cfg.command ? await probeStdio(cfg, 45000) : await probeHttp(cfg, 20000);
    return [n, { ...r, status: r.ok ? '✔ Connected' : '✗ Failed: ' + r.error }];
  }));
  const servers = Object.fromEntries(results);
  const output = results.map(([n, r]) => {
    const cfg = config.mcpServers[n];
    return n + ': ' + (cfg.command ? [cfg.command, ...(cfg.args || [])].join(' ') : (cfg.serverUrl || cfg.url) + ' (HTTP)') + ' - ' + r.status;
  }).join('\n');
  return { output: output || '(nenhum MCP configurado no Antigravity)', code: 0, servers };
}

const validName = (n) => /^[A-Za-z0-9_.-]{1,64}(?![\s\S])/.test(String(n || ''));
async function addMcp(b) {
  if (!validName(b.name)) throw new Error('nome inválido (use letras, números, _ . -)');
  const transport = b.transport || (b.url ? 'http' : 'stdio');
  if (transport === 'stdio' && !b.command) throw new Error('informe o comando');
  if (transport !== 'stdio' && !b.url) throw new Error('informe a URL');
  let r;
  if ((b.provider || 'claude') === 'claude') {
    const cfg = transport === 'stdio'
      ? { type: 'stdio', command: b.command, args: b.args || [], env: b.env || {} }
      : { type: transport, url: b.url, headers: b.headers || {} };
    r = await execCmd(CLAUDE_BIN, ['mcp', 'add-json', '-s', b.scope || 'user', b.name, JSON.stringify(cfg)], 60000);
  } else {
    if (!fs.existsSync(AGY_BIN)) throw new Error('agy não está instalado');
    // Flags have to come before the name; `--` keeps commands/args that start with '-' intact.
    const flags = [];
    if (transport === 'stdio') for (const [k, v] of Object.entries(b.env || {})) flags.push('--env', k + '=' + v);
    else for (const [k, v] of Object.entries(b.headers || {})) flags.push('--header', k + ': ' + v);
    r = await execCmd(AGY_BIN, transport === 'stdio' ? ['mcp', 'add', ...flags, '--', b.name, b.command, ...(b.args || [])] : ['mcp', 'add', ...flags, '--', b.name, b.url], 60000);
  }
  audit({ action: 'mcp-add', provider: b.provider || 'claude', name: b.name, transport, ok: r.code === 0 });
  if (r.code !== 0) throw new Error((r.err || r.out || 'falhou com código ' + r.code).trim().slice(0, 800));
  return { ok: true, output: (r.out + r.err).trim() };
}
async function removeMcp(provider, name, scope) {
  if (!validName(name)) throw new Error('nome inválido');
  const r = provider === 'antigravity'
    ? await execCmd(AGY_BIN, ['mcp', 'remove', name], 60000)
    : await execCmd(CLAUDE_BIN, ['mcp', 'remove', '-s', scope || 'user', name], 60000);
  audit({ action: 'mcp-remove', provider, name, ok: r.code === 0 });
  if (r.code !== 0) throw new Error((r.err || r.out || 'falhou com código ' + r.code).trim().slice(0, 800));
  return { ok: true, output: (r.out + r.err).trim() };
}

function readAudit(n) {
  try {
    return fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').slice(-n).reverse()
      .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch { return []; }
}

async function handleAdmin(req, res, u, raw) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!adminAuthorized(req)) return send(ADMIN_TOKEN ? 401 : 503, { error: ADMIN_TOKEN ? 'não autorizado' : 'BRIDGE_ADMIN_TOKEN não configurado' });
  const parts = u.pathname.split('/').slice(2).map(decodeURIComponent); // after /admin
  const m = req.method;
  let body = {};
  if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return send(400, { error: 'JSON inválido' }); } }
  const [a, b, c2] = parts;
  try {
    if (a === 'memory') {
      const ws = u.searchParams.get('workspace') || 'default', proj = u.searchParams.get('project') || '';
      if (b === 'projects' && m === 'GET') return send(200, { projects: await aiMemGet('/projects'), local: { dir: MEMORY_DIR, count: localMemList().length } });
      if (b === 'pages' && m === 'GET') return send(200, await aiMemGet(memScope(ws, proj) + '/pages'));
      if (b === 'page' && m === 'GET') return send(200, await aiMemGet(memScope(ws, proj) + '/pages/' + safePagePath(u.searchParams.get('path')).split('/').map(encodeURIComponent).join('/')));
      if (b === 'page' && m === 'PUT') {
        const args = ['write-page', '--workspace', body.workspace || ws, '--project', body.project || proj, '--path', safePagePath(body.path), '--title', String(body.title || body.path), '--body', String(body.body || '')];
        if (body.kind) args.push('--kind', String(body.kind));
        if (body.tier) args.push('--tier', String(body.tier));
        for (const t of body.tags || []) args.push('--tag', String(t));
        if (body.pinned) args.push('--pinned');
        const r = await execCmd(aiMemoryBin(), args, 60000);
        if (r.code !== 0) return send(500, { error: (r.err || r.out).split('\n').filter((l) => !/ INFO /.test(l)).join('\n').slice(-600) || 'write-page falhou' });
        audit({ action: 'memory-write', project: body.project || proj, path: body.path, via: 'panel' });
        return send(200, { ok: true });
      }
      if (b === 'page' && m === 'DELETE') {
        const pth = safePagePath(u.searchParams.get('path'));
        const r = await execCmd(aiMemoryBin(), ['delete-page', '--workspace', ws, '--project', proj, '--path', pth], 60000);
        if (r.code !== 0) return send(500, { error: (r.err || r.out).split('\n').filter((l) => !/ INFO /.test(l)).join('\n').slice(-600) || 'delete-page falhou' });
        audit({ action: 'memory-delete', project: proj, path: pth, via: 'panel' });
        return send(200, { ok: true });
      }
      if (b === 'local' && m === 'GET') return send(200, { dir: MEMORY_DIR, items: localMemList() });
      if (b === 'local' && m === 'PUT') { const f = localMemWrite(body); audit({ action: 'memory-local-write', file: f, via: 'panel' }); return send(200, { ok: true, file: f }); }
      if (b === 'local' && m === 'DELETE') { const f = u.searchParams.get('file'); localMemDelete(f); audit({ action: 'memory-local-delete', file: f, via: 'panel' }); return send(200, { ok: true }); }
    }
    if (a === 'usage' && m === 'GET') return send(200, await usageReport(Math.min(120, Math.max(7, Number(u.searchParams.get('days')) || 56))));
    if (a === 'overview' && m === 'GET') {
      return send(200, { version: VERSION, tz: TZ, permissionMode: PERMISSION_MODE, workdir: WORKDIR, uptime: Math.round(process.uptime()),
        aiMemory: { status: aiMemory.status, restarts: aiMemory.restarts }, allowed: ALLOWED.length, settings,
        running: [...running.entries()].map(([id, r]) => ({ chatId: id, started: r.started, prompt: r.prompt })),
        chats: Object.keys(chats).length, schedules: schedules.length });
    }
    if (a === 'providers' && m === 'GET') return send(200, await providersInfo());
    if (a === 'settings' && m === 'PUT') {
      for (const k of ['defaultProvider', 'claudeModel', 'claudeEffort']) {
        if (!(k in body)) continue;
        if (!body[k]) delete settings[k]; else settings[k] = String(body[k]);
      }
      if (settings.defaultProvider && !PROVIDERS[settings.defaultProvider]) throw new Error('provedor inválido');
      if (settings.claudeEffort && !EFFORTS.includes(settings.claudeEffort)) throw new Error('esforço inválido');
      saveSettings();
      return send(200, settings);
    }
    if (a === 'chats' && !b && m === 'GET') {
      return send(200, Object.keys(chats).map(chatView).sort((x, y) => String((y.runs.at(-1) || {}).at || y.created).localeCompare(String((x.runs.at(-1) || {}).at || x.created))));
    }
    if (a === 'chats' && b && !c2 && m === 'PATCH') {
      if (!chats[b]) return send(404, { error: 'conversa não encontrada' });
      const c = chats[b];
      if ('provider' in body) { if (body.provider && !PROVIDERS[body.provider]) throw new Error('provedor inválido'); if (body.provider) c.provider = body.provider; else delete c.provider; }
      for (const k of ['model', 'effort', 'agyModel', 'agyEffort', 'title']) if (k in body) { if (body[k]) c[k] = String(body[k]); else delete c[k]; }
      if (c.effort && !EFFORTS.includes(c.effort)) { delete c.effort; throw new Error('esforço inválido'); }
      if (body.reset) { delete c.session; delete c.agySession; }
      save();
      return send(200, chatView(b));
    }
    if (a === 'chats' && b && c2 === 'stop' && m === 'POST') {
      const r = running.get(b);
      if (!r) return send(200, { stopped: false });
      r.child.kill('SIGTERM');
      return send(200, { stopped: true });
    }
    if (a === 'chats' && b && !c2 && m === 'DELETE') {
      if (!isWeb(b)) throw new Error('só conversas web podem ser apagadas');
      const r = running.get(b); if (r) r.child.kill('SIGTERM');
      delete chats[b]; save();
      schedules = schedules.filter((s) => s.chatId !== b); saveSched();
      try { fs.unlinkSync(webFile(b)); } catch {}
      return send(200, { deleted: b });
    }
    if (a === 'web' && !b && m === 'POST') {
      const id = 'web:' + crypto.randomBytes(6).toString('hex');
      const c = chat(id);
      c.title = body.title || 'Nova conversa'; c.created = new Date().toISOString();
      if (body.provider && PROVIDERS[body.provider]) c.provider = body.provider;
      for (const k of ['model', 'effort', 'agyModel', 'agyEffort']) if (body[k]) c[k] = String(body[k]);
      save();
      return send(200, chatView(id));
    }
    if (a === 'web' && b && c2 === 'messages' && m === 'GET') {
      const id = 'web:' + b;
      if (!chats[id]) return send(404, { error: 'conversa não encontrada' });
      return send(200, { chat: chatView(id), messages: webHistory(id) });
    }
    if (a === 'web' && b && c2 === 'messages' && m === 'POST') {
      const id = 'web:' + b;
      if (!chats[id]) return send(404, { error: 'conversa não encontrada' });
      const text = String(body.text || '').trim();
      const transcript = String(body.transcript || '').trim().slice(0, 4000);
      const files = saveWebFiles(body.files);
      if (!text && !files.length) throw new Error('mensagem vazia');
      webSend(id, text, files, transcript);
      return send(202, { queued: true, ahead: Math.max(0, (pending.get(id) || 1) - 1) });
    }
    if (a === 'web' && b === 'files' && c2 && m === 'GET') {
      const name = path.basename(c2);
      const file = path.join(INBOX, name);
      if (!name.startsWith('web-') || !fs.existsSync(file)) return send(404, { error: 'arquivo não encontrado' });
      const ext = path.extname(name).toLowerCase();
      const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
        '.pdf': 'application/pdf', '.webm': 'audio/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.txt': 'text/plain' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'private, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }
    if (a === 'web' && b && c2 === 'events' && m === 'GET') {
      const id = 'web:' + b;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const write = (ev) => res.write('data: ' + JSON.stringify(ev) + '\n\n');
      write({ type: 'hello', running: running.has(id) ? { started: running.get(id).started } : null });
      const set = webListeners.get(id) || new Set();
      set.add(write); webListeners.set(id, set);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      res.on('close', () => { clearInterval(ping); set.delete(write); if (!set.size) webListeners.delete(id); });
      return;
    }
    if (a === 'schedules' && !b && m === 'GET') return send(200, schedules.map((s) => ({ ...s, chatTitle: chatView(s.chatId).title })));
    if (a === 'schedules' && !b && m === 'POST') return send(200, addSchedule(body));
    if (a === 'schedules' && b) {
      const s = schedules.find((x) => x.id === b);
      if (!s) return send(404, { error: 'agendamento não encontrado' });
      if (m === 'PATCH') {
        if ('paused' in body) s.paused = Boolean(body.paused);
        if (body.description) s.description = String(body.description).slice(0, 120);
        if (body.prompt) s.prompt = String(body.prompt);
        if (body.cron) { if (!validCron(body.cron)) throw new Error('cron inválido'); s.cron = String(body.cron).trim(); }
        saveSched();
        return send(200, s);
      }
      if (m === 'POST' && c2 === 'run') { runSchedule(s); return send(200, { started: true }); }
      if (m === 'DELETE') {
        schedules = schedules.filter((x) => x !== s); saveSched();
        audit({ action: 'schedule-delete', id: s.id, via: 'panel' });
        return send(200, { deleted: s.id });
      }
    }
    if (a === 'mcp' && !b && m === 'GET') {
      const agy = await agyMcp();
      const cl = claudeMcpConfig();
      return send(200, { claude: { user: redactServers(cl.user), local: redactServers(cl.local), project: redactServers(cl.project) }, antigravity: agy });
    }
    if (a === 'mcp' && b === 'status' && m === 'GET') {
      if (u.searchParams.get('provider') === 'antigravity') return send(200, await agyMcpStatus());
      const r = await execCmd(CLAUDE_BIN, ['mcp', 'list'], 90000);
      return send(200, { output: (r.out + (r.code ? '\n' + r.err : '')).trim(), code: r.code });
    }
    if (a === 'mcp' && !b && m === 'POST') return send(200, await addMcp(body));
    if (a === 'mcp' && b && c2 && m === 'DELETE') return send(200, await removeMcp(b, c2, u.searchParams.get('scope')));
    if (a === 'audit' && m === 'GET') return send(200, readAudit(Math.min(Number(u.searchParams.get('n')) || 100, 1000)));
    if (a === 'send' && m === 'POST') {
      const out = await sendMessage({ to: body.to, text: body.text, raw: true });
      return send(200, out);
    }
    return send(404, { error: 'rota não encontrada' });
  } catch (e) {
    return send(400, { error: e.message });
  }
}

// ---------- HTTP ----------
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, version: VERSION, allowed: ALLOWED.length, running: running.size,
      aiMemory: { status: aiMemory.status, restarts: aiMemory.restarts, supervised: Boolean(aiMemory.child) } }));
  }
  const bufs = [];
  req.on('data', (d) => bufs.push(d));
  req.on('end', async () => {
    const raw = Buffer.concat(bufs);
    const u = new URL(req.url, 'http://local');
    if (u.pathname.startsWith('/admin/')) return handleAdmin(req, res, u, raw).catch((e) => { log('admin error', e.message); try { res.writeHead(500); res.end(); } catch {} });
    if (u.pathname.startsWith('/schedules')) {
      if (!isLocal(req)) { res.writeHead(403); return res.end(); }
      try {
        let out;
        if (req.method === 'GET') {
          const cid = u.searchParams.get('chatId');
          out = schedules.filter((s) => !cid || s.chatId === cid);
        } else if (req.method === 'POST') {
          out = addSchedule(JSON.parse(raw.toString('utf8') || '{}'));
        } else if (req.method === 'DELETE') {
          const id = u.pathname.split('/')[2];
          const n = schedules.length;
          schedules = schedules.filter((s) => s.id !== id);
          if (n === schedules.length) throw new Error('id não encontrado');
          saveSched();
          audit({ action: 'schedule-delete', id, via: 'api' });
          out = { deleted: id };
        } else throw new Error('método não suportado');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(out, null, 2));
      } catch (e) {
        res.writeHead(400); return res.end('erro: ' + e.message);
      }
    }
    if (req.method === 'POST' && req.url === '/send') {
      if (!isLocal(req)) { res.writeHead(403); return res.end(); }
      try {
        const out = await sendMessage(JSON.parse(raw.toString('utf8') || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400); return res.end('erro: ' + e.message);
      }
    }
    if (req.method === 'POST' && req.url === '/send-file') {
      if (!isLocal(req)) { res.writeHead(403); return res.end(); }
      try {
        await sendFile(JSON.parse(raw.toString('utf8')));
        res.writeHead(200); return res.end('enviado');
      } catch (e) {
        res.writeHead(500); return res.end('erro: ' + e.message);
      }
    }
    if (req.method !== 'POST' || !req.url.startsWith('/webhook')) { res.writeHead(404); return res.end(); }
    if (WEBHOOK_HMAC_KEY) {
      const got = String(req.headers['x-webhook-hmac'] || '');
      const want = crypto.createHmac('sha512', WEBHOOK_HMAC_KEY).update(raw).digest('hex');
      if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
        log('rejected webhook: bad hmac');
        res.writeHead(401); return res.end();
      }
    }
    res.writeHead(200); res.end('ok');
    let evt;
    try { evt = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (evt.session && evt.session !== WAHA_SESSION) return;
    if (evt.event === 'message' || evt.event === 'message.any') handleMessage(evt.payload).catch((e) => log('handle error', e.message));
    if (evt.event === 'poll.vote') handlePollVote(evt.payload).catch((e) => log('vote error', e.message));
  });
});

// Tell each allowed number that the service is up. Retries, because WAHA may not be ready right after boot.
async function notifyStartup() {
  // Natural, varied wording. Only sent to ALLOWED_NUMBERS, never to anyone else.
  const phrases = [
    'Oi! Aqui é o Claude. O serviço acabou de subir e já está pronto para uso.',
    'Olá, tudo certo por aqui. O serviço já está no ar e disponível para você mandar mensagens.',
    'Oi, só avisando que o serviço voltou e já está pronto para uso.',
  ];
  const text = phrases[Math.floor(Math.random() * phrases.length)];
  for (const number of ALLOWED) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try { await sendMessage({ to: number, text, raw: true }); log('startup notice sent'); break; }
      catch (e) {
        log('startup notice to', number, 'attempt', attempt, 'failed:', e.message);
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
  }
}

server.listen(PORT, () => {
  log('bridge listening on', PORT, '| version', VERSION, '| session', WAHA_SESSION, '| allowed numbers', ALLOWED.length, '| mode', PERMISSION_MODE);
  if (!ALLOWED.length) log('WARNING: ALLOWED_NUMBERS is empty, every message will be ignored');
  if (env.STARTUP_NOTICE !== 'false') setTimeout(notifyStartup, 10000);
  ensureAiMemory().then(() => log('ai-memory:', aiMemory.status)).catch((e) => log('ai-memory check failed', e.message));
  setInterval(() => ensureAiMemory().catch(() => {}), 60000).unref();
  // Read the Antigravity model list once at boot, so the log shows what agy offers right now.
  if (fs.existsSync(AGY_BIN)) refreshAgyCatalog(true).then((cat) => {
    log('agy models:', cat.models.map((g) => g.base + (g.efforts.length ? '[' + g.efforts.join('/') + ']' : '')).join(', ') || 'none');
    log('agy models raw:', JSON.stringify(stripAnsi(cat.raw).slice(0, 1500)));
  }).catch((e) => log('agy models failed', e.message));
});
