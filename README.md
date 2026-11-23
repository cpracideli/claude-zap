# claude-zap

Talk to **Claude Code** (and Antigravity, Copilot, OpenCode, Ollama or any OpenAI-compatible API) from **Agent Control** (web/PWA panel), **WhatsApp (WAHA)**, **Telegram**, **Discord** or **Slack**.

Runs on your own [Coolify](https://coolify.io) server using your **Claude subscription** (`claude setup-token`, no per-token API billing) and persists your workspace, sessions, bots, routines, Mini-Apps, encrypted vault, and live browser profile in a Docker volume.

```
  Web Panel (Agent Control) ──┐
  WhatsApp (WAHA) ────────────┼──► claude-zap bridge ──► Claude Code / Providers
  Telegram / Discord / Slack ─┘          │
                                    Live Computer (noVNC + Chromium)
```

---

## Contents

1. [Quick Start: All-in-One Stack on Coolify (`docker-compose.stack.yml`)](#quick-start-all-in-one-stack-on-coolify)
2. [Standalone Bridge + WAHA Setup](#standalone-bridge--waha-setup)
3. [Using it](#using-it)
4. [Configuration reference](#configuration-reference)
5. [Security model](#security-model-read-this)
6. [Updating](#updating)
7. [Backup and migration](#backup-and-migration)
8. [Troubleshooting](#troubleshooting)
9. [Development and tests](#development-and-tests)

---

## Quick Start: All-in-One Stack on Coolify

The easiest way for a new user to run **Bridge + Agent Control Web Panel** in a **single Coolify resource** (with Live Computer `noVNC`/`Xvfb`, `ffmpeg`, `espeak-ng`, Chromium, and Claude Code installed automatically on first boot):

### What you need

| Requirement | Notes |
|---|---|
| A server running **Coolify v4** | Tested on Coolify 4.7+. 2 vCPU / 4 GB RAM is comfortable. ARM64 and x86_64 both work. |
| A **Claude subscription** (Pro or Max) | Used through `claude setup-token` (or `ANTHROPIC_API_KEY`). |
| **Optional:** WAHA, Telegram, Discord, Slack, Gemini/Groq/OpenAI keys | WhatsApp is completely optional — the web panel works out of the box without WAHA. |

### 1. Get your Claude subscription token

On any machine with Claude Code signed in:

```bash
claude setup-token
```

Copy the printed token (`sk-ant-oat01-...`). Never share or commit it.

### 2. Create the stack resource in Coolify

1. In Coolify, open your project/environment and click **+ New Resource** → **Public Git Repository**.
2. Repository URL: `https://github.com/cpracideli/claude-zap` (or your fork). Click **Check Repository**.
3. Build Pack: **Docker Compose**, Docker Compose Location: **`/docker-compose.stack.yml`**, branch `main`.
4. Under **Domains**, assign a domain to the **`agent-control`** service (e.g. `https://agent.yourdomain.com:3001` or Coolify's generated `sslip.io` domain). Do **not** expose `claude-bridge` publicly unless you need external webhooks.

### 3. Set the 4 required Environment Variables

| Variable | Value |
|---|---|
| `ADMIN_PASSWORD` | Strong password to log in to the web panel |
| `BRIDGE_ADMIN_TOKEN` | Long random secret shared between bridge and panel |
| `CLAUDE_CODE_OAUTH_TOKEN` | Token from `claude setup-token` (or set `ANTHROPIC_API_KEY`) |
| `TZ` | Your timezone, e.g. `America/Sao_Paulo` |

Optional extras you can set anytime in Coolify:
- `OWNER_NAME` (your first name for greetings/briefings)
- `PUBLIC_URL` (`https://agent.yourdomain.com` for OAuth, Web Push, webhooks, Mini-Apps)
- `COOLIFY_URL`, `COOLIFY_TOKEN`, `COOLIFY_APP_UUID` (unlocks Coolify Envs, Logs, Restart/Deploy inside the panel)
- `WAHA_URL`, `WAHA_API_KEY`, `WAHA_SESSION`, `ALLOWED_NUMBERS` (connects WhatsApp)
- `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` (native voice transcription & TTS; falls back offline to `espeak-ng`)
- `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX` (sending e-mail drafts)

### 4. Deploy & open Agent Control

Click **Deploy**. First boot installs system packages (`ffmpeg`, `xvfb`, `x11vnc`, `novnc`, `espeak-ng`, `chromium`, Claude Code) and builds the panel frontend (~2–4 minutes). Open your domain and sign in with `ADMIN_PASSWORD`!

---

## Standalone Bridge + WAHA Setup

If you prefer running `claude-zap` alone (`docker-compose.yml`, single `claude-bridge` service) or wiring it manually to WAHA:

### Step 1. Deploy WAHA (skip if you already have it or use web-only)

1. In Coolify, click **+ New Resource** → **WAHA** (or `devlikeapro/waha`).
2. Set `WAHA_API_KEY` to a random secret and deploy.
3. Open `https://<your-waha-domain>/dashboard`, start a session, scan the QR code with the **bot's** WhatsApp, and note the exact session name (`WORKING`).

### Step 2. Create the bridge resource

1. **+ New Resource** → **Public Git Repository** → `https://github.com/cpracideli/claude-zap` (`docker-compose.yml`).
2. Fill in `CLAUDE_CODE_OAUTH_TOKEN`, `BRIDGE_ADMIN_TOKEN`, `WAHA_URL`, `WAHA_API_KEY`, `WAHA_SESSION`, `ALLOWED_NUMBERS`, `TZ`.
3. Under **Advanced**:
   - Enable **Connect to predefined network** (`coolify`).
   - Enable **Consistent container name** and set **Custom container name** to `claude-zap` (container becomes `claude-bridge-claude-zap`).
4. Deploy and wait for **Running (healthy)**.

### Step 3. Point the WAHA webhook at the bridge

1. WAHA dashboard → **Sessions** → gear icon → **Webhooks**:
   - **URL:** `http://claude-bridge-claude-zap:3000/webhook`
   - **Events:** `message`, `poll.vote`, `message.reaction`
2. Send `/help` from your own number (`ALLOWED_NUMBERS`) to the bot's WhatsApp.

---

## Using it

| You send | What happens |
|---|---|
| Any text | Goes to the active provider/bot. Conversation context is preserved. |
| Image, audio or document | Saved to `workspace/inbox`; audio is auto-transcribed if Groq/OpenAI or `~/bin/transcrever` is configured. |
| `/new` | Starts a fresh conversation (keeps model & effort). |
| `/provider` / `/model` / `/effort` | Changes provider, model or effort for this chat. |
| `/status` / `/usage` / `/log [n]` | Shows running tasks, usage/cost and recent runs. |
| `/stop` | Interrupts the current task. |
| `/send +55 11 99999-8888 hello` | Sends a WhatsApp message to another number. |
| `/schedules`, `/pause <id>`, `/resume <id>`, `/cancel <id>` | Manage scheduled tasks and routines. |
| `/bot [name]` | Switches persona/bot for the chat. |
| `/council <question>` | Runs multiple models in parallel and synthesizes the best answer. |
| `/help` | Interactive command menu. |

- **Bots & Engineering Team:** create custom personas with isolated memory, scoped MCPs, Kanban Board tickets, parallel tasks, and delegation.
- **Routines:** cron, one-shot `at`, **webhooks** (`POST <panel>/hooks/<id>/<token>`), **watch** commands, and `quiet` mode (`NADA_A_RELATAR`).
- **Mini-Apps / Pages:** HTML dashboards with persistent JSON storage (`window.PageData`) and optional public links (`/p/:id/:token`).
- **Live Computer:** server-side Chromium inside Xvfb + noVNC where you can take over for logins/2FA/CAPTCHA, plus encrypted AES-GCM credential autofill.
- **Voice:** native `POST /send-voice` (WhatsApp PTT) and web TTS playback using `~/bin/falar`, Gemini TTS, OpenAI TTS, or offline `espeak-ng`.

---

## Configuration reference

See [`.env.example`](.env.example) for the complete annotated template.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | (empty) | Claude subscription token (`claude setup-token`) |
| `ANTHROPIC_API_KEY` | (empty) | Alternative Anthropic API key |
| `BRIDGE_ADMIN_TOKEN` | (empty) | Enables `/admin/*` API for Agent Control (required when using the panel) |
| `OWNER_NAME` | (empty) | Owner display name used in memory prompts, reminders & briefings |
| `WAHA_URL` | (empty) | WAHA base URL (leave empty to run without WhatsApp) |
| `WAHA_API_KEY` | (empty) | WAHA API key |
| `WAHA_SESSION` | `default` | WAHA session name (case-sensitive) |
| `ALLOWED_NUMBERS` | (empty) | Comma-separated phone numbers allowed on WhatsApp |
| `TZ` | `America/Sao_Paulo` | Timezone for schedules and prompts |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | Claude Code permission mode |
| `CLAUDE_ALLOWED_TOOLS` | `Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,TodoWrite` | Allowed tools when mode is not `bypassPermissions` |
| `CLAUDE_MODEL` / `CLAUDE_EFFORT` | account default | Default model and effort |
| `CLAUDE_TIMEOUT_SECONDS` | `1800` | Max duration per task |
| `GROQ_API_KEY` | (empty) | Enables native Whisper voice transcription (STT) |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | (empty) | Enables native TTS/STT fallback (`espeak-ng` works offline without keys) |
| `AGENTMAIL_API_KEY` / `AGENTMAIL_INBOX` | (empty) | Enables sending email drafts via AgentMail API |
| `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` / `SLACK_BOT_TOKEN` | (empty) | Optional chat channels (can also be configured in the panel) |
| `AI_MEMORY` / `AI_MEMORY_SERVER_URL` | `on` / `http://127.0.0.1:49374` | Supervises `ai-memory serve` when installed |
| `WEBHOOK_HMAC_KEY` | (empty) | HMAC verification when `/webhook` is exposed publicly |
| `VAULT_KEY` | `BRIDGE_ADMIN_TOKEN` | Encryption key for AES-GCM secrets vault |

---

## Security model (read this)

- **Container scope:** the agent runs with `bypassPermissions` and passwordless `sudo` inside its container so it can install tools and automate tasks. Keep secrets out of the container unless the assistant should use them.
- **Access control:** WhatsApp access is restricted to `ALLOWED_NUMBERS` (plus optional scoped guests); Telegram/Discord/Slack use their own user/channel allowlists; `/admin/*` requires `BRIDGE_ADMIN_TOKEN`.
- **Internal endpoints:** `/send`, `/send-file`, `/send-voice`, `/schedules`, `/tickets`, `/pages`, `/prompts`, `/secrets` (local route) accept connections only from `127.0.0.1`.
- **Audit log:** actions are logged to `~/.bridge/audit.log` inside the `claude-home` volume.

---

## Updating

`docker-compose.yml` and `docker-compose.stack.yml` embed `bridge/bridge.mjs`, so regenerate them after any edit to the bridge:

1. Edit `bridge/bridge.mjs`.
2. Run `node build-compose.mjs` (verifies zero `$` in `bridge/bridge.mjs` and writes both compose files).
3. Run tests, commit, and push.
4. In Coolify, update the `/app/bridge.mjs` file storage mount (or patch via Coolify API) before redeploying, because Coolify preserves initial `content:` file mounts across redeploys. Check `GET /health` → `version` afterwards.

All state lives in the `claude-home` volume (`/home/node`) and survives redeploys.

---

## Backup and migration

```bash
# find the volume
docker volume ls | grep claude-home

# back it up
mkdir -p /root/backups
docker run --rm -v <volume>:/data -v /root/backups:/backup node:22-bookworm-slim \
  tar czf /backup/claude-home.tgz -C /data .

# restore into another volume (with target bridge stopped)
docker run --rm -v <new-volume>:/data -v /root/backups:/backup node:22-bookworm-slim \
  sh -c "cd /data && tar xzf /backup/claude-home.tgz"
```

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| No reply on WhatsApp | Check bridge **Running (healthy)**, WAHA session `WORKING`, webhook URL + `WAHA_SESSION` exact match, and sender number in `ALLOWED_NUMBERS`. |
| Panel shows Coolify "opcional · não configurado" | Normal if you didn't set `COOLIFY_URL`/`COOLIFY_TOKEN`/`COOLIFY_APP_UUID`. Set all 3 to manage envs/logs/restart from the panel. |
| Redeploy did not change bridge behavior | Coolify kept the cached `/app/bridge.mjs` storage mount. Update the storage content and check `/health` → `version`. |
| Voice TTS error | Set `GEMINI_API_KEY` or `OPENAI_API_KEY`, or ensure `espeak-ng` and `ffmpeg` are installed. |

---

## Development and tests

Zero npm dependencies for the bridge (plain Node.js 22):

```bash
node --check bridge/bridge.mjs
node build-compose.mjs
node test/portability-test.mjs
node test/run-test.mjs
node test/admin-test.mjs
```

## License

MIT. See [LICENSE](LICENSE).
