# claude-zap

Talk to **Claude Code** from WhatsApp. You send a message to a WhatsApp number, Claude Code runs on your own server, does the work (research, files, scripts, installs), and replies in the same chat. It can also message other people for you and run scheduled tasks ("every day at 8am send me the weather").

It runs on [Coolify](https://coolify.io), uses [WAHA](https://waha.devlike.pro) as the WhatsApp gateway, and uses your **Claude subscription** (no per-token API billing).

```
 Your WhatsApp ──► WAHA (WhatsApp gateway) ──webhook──► claude-zap bridge ──► Claude Code
        ▲                                                       │
        └──────────────────── reply via WAHA ◄──────────────────┘
```

---

## Contents

1. [What you need](#what-you-need)
2. [Setup, step by step](#setup-step-by-step)
3. [Using it](#using-it)
4. [Configuration reference](#configuration-reference)
5. [Security model](#security-model-read-this)
6. [Updating](#updating)
7. [Backup and migration](#backup-and-migration)
8. [Troubleshooting](#troubleshooting)
9. [Development and tests](#development-and-tests)

---

## What you need

| Requirement | Notes |
|---|---|
| A server running **Coolify v4** | Tested on Coolify 4.7. 2 vCPU / 4 GB RAM is comfortable. ARM64 and x86_64 both work. |
| A **WAHA** instance in the same Coolify | Logged in to the WhatsApp number the bot will use. Any edition works for text; downloading received media may need WAHA Plus. |
| A **Claude subscription** (Pro or Max) | Used through `claude setup-token`. |
| A WhatsApp number for the bot | Ideally a separate number used only by the bot. |
| Your own WhatsApp number | The number you will talk to the bot from. |

---

## Setup, step by step

### Step 1. Deploy WAHA (skip if you already have it)

1. In Coolify, open your project and click **+ New Resource**. Pick the **WAHA** service template (or deploy the `devlikeapro/waha` image).
2. Set `WAHA_API_KEY` to a long random value and keep it somewhere safe.
3. Give WAHA a domain (Coolify can generate one) and deploy.
4. Open `https://<your-waha-domain>/dashboard`, start a session and scan the QR code with the **bot's** WhatsApp.
5. Write down the **exact session name** (for example `default` or `Business`) and wait until the status is `WORKING`.

### Step 2. Get a Claude subscription token

On any computer where Claude Code is installed and logged in to your subscription:

```bash
claude setup-token
```

Copy the token it prints (it starts with `sk-ant-oat01-`). Treat it like a password: never paste it in a chat or commit it.

### Step 3. Create the bridge from this repository

1. In Coolify, open the **same project and environment** as WAHA (or any environment on the same server) and click **+ New Resource**.
2. Choose **Public Git Repository**.
3. Repository URL: `https://github.com/cpracideli/claude-zap` (or your fork). Click **Check Repository**.
4. Coolify detects **Docker Compose** and `docker-compose.yml`. Keep branch `main`, base directory `/`. Click **Continue**.
5. **Do not deploy yet.**

### Step 4. Set the environment variables

Open the new resource → **Environment Variables** and fill in:

| Variable | What to put | Required |
|---|---|---|
| `WAHA_URL` | Your WAHA URL, e.g. `https://waha.example.com` | yes |
| `WAHA_API_KEY` | The key from step 1 | yes |
| `WAHA_SESSION` | The **exact** session name from step 1 (case-sensitive). If it does not match, every message is silently ignored. | yes |
| `ALLOWED_NUMBERS` | **Your own** number (not the bot's), digits with country code, e.g. `5511999998888`. Several numbers: separate with commas. | yes |
| `CLAUDE_CODE_OAUTH_TOKEN` | The token from step 2 | yes |
| `TZ` | Your timezone, e.g. `America/Sao_Paulo` (used for schedules) | recommended |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` (default) | optional |

Leave the other variables empty to use their defaults. Leave `ANTHROPIC_API_KEY` empty when you use the subscription token. See `.env.example` for the full list.

### Step 5. Give the bridge a stable network name

WAHA calls the bridge over Coolify's internal `coolify` Docker network. By default Coolify adds a timestamp to the container name on **every** deploy, which would break the webhook. Fix both things once:

1. Open the resource → **Advanced**.
2. **Docker compose → Predefined network:** select **Connect to predefined network**.
3. **Container → Container naming:** select **Consistent name (no rolling updates)**.
4. **Custom container name:** type `claude-zap` and press Enter.

The container will now always be called **`claude-bridge-claude-zap`**.

### Step 6. Deploy

Click **Deploy**. The first start takes a few minutes: it installs `sudo`, basic tools and Claude Code. When it is ready the status turns **Running (healthy)**.

Optional check: open Coolify's **Terminal**, pick the server (`localhost`) and run:

```bash
docker run --rm --network coolify node:22-bookworm-slim node -e "fetch('http://claude-bridge-claude-zap:3000/health').then(r=>r.text()).then(console.log).catch(e=>console.log('ERROR', e.cause && e.cause.code))"
```

Expected: `{"ok":true,"allowed":1,"running":0}`. (`curl` is not in this image, so the check uses Node.)

### Step 7. Point the WAHA webhook at the bridge

1. Open the WAHA dashboard → **Sessions** → click the gear icon of **your bot's session**.
2. Scroll to **Webhooks** and add (or edit) one:
   - **URL:** `http://claude-bridge-claude-zap:3000/webhook`
   - **Events:** `message`
   - Leave HMAC and custom headers empty.
3. Click **Update**. WAHA restarts the session; wait until it is `WORKING` again.

### Step 8. Test

From **your own** WhatsApp (a number in `ALLOWED_NUMBERS`), send `/help` to the **bot's** number. You should get the command list. Then ask anything, for example "What's the weather in São Paulo today?".

---

## Using it

| You send | What happens |
|---|---|
| Any text | Goes to Claude Code. The conversation context is kept between messages. |
| An image, audio or document | Saved to the inbox; Claude gets the file path and can analyse it. |
| `/new` | Starts a fresh conversation (keeps the model and effort). |
| `/model opus` (`sonnet`, `haiku`, `padrao`) | Changes the model for this chat. Saved. |
| `/effort high` (`low` … `max`, `padrao`) | Changes the effort level for this chat. Saved. |
| `/status` | Session, model, what is running, queue, totals. |
| `/usage` | Total runs, errors, time and estimated cost for this chat. |
| `/log [n]` | Last *n* runs (default 5, max 20) with time, duration, cost and errors. |
| `/stop` | Interrupts the current task. The conversation continues. |
| `/send +55 11 99999-8888 hello` | Sends a WhatsApp message to another number, directly from the bridge. |
| `/schedules` | Lists scheduled tasks. |
| `/pause <id>` / `/resume <id>` | Pauses (toggles) or resumes a scheduled task. |
| `/cancel <id>` | Deletes a scheduled task. |
| `/help` | Lists the commands. |

Commands are in English. The old Portuguese names (`/enviar`, `/agenda`, `/pausar`, `/cancelar`, `/esforco`, ...) were removed.

The bot answers in Brazilian Portuguese by default (see `systemPrompt()` in `bridge/bridge.mjs` to change it).

**Scheduling** works in plain language: "every day at 8am send me the top AI news" or "remind me tomorrow at 3pm to call John". Claude creates the schedule through the bridge; results arrive prefixed with ⏰.

**Messaging others:** ask Claude ("tell +55 11 98888-7777 I'm 10 minutes late") or use `/send`. Messages go out from the bot's number. Replies from that person do not reach Claude.

**Installing tools:** ask Claude to install anything ("install the Playwright MCP"). It has passwordless `sudo`. New MCP servers are available from the next message.

---

## Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `WAHA_URL` | (required) | WAHA base URL |
| `WAHA_API_KEY` | (required) | WAHA API key |
| `WAHA_SESSION` | `default` | WAHA session name; must match exactly |
| `ALLOWED_NUMBERS` | (required) | Numbers allowed to use the bot |
| `CLAUDE_CODE_OAUTH_TOKEN` | (empty) | Subscription token (recommended) |
| `ANTHROPIC_API_KEY` | (empty) | Alternative: API key instead of the subscription |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | Claude Code permission mode |
| `CLAUDE_ALLOWED_TOOLS` | `Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,TodoWrite` | Only used when the mode is not `bypassPermissions` |
| `CLAUDE_MODEL` | account default | Default model |
| `CLAUDE_EFFORT` | account default | Default effort |
| `CLAUDE_TIMEOUT_SECONDS` | `1800` | Maximum duration of one task |
| `TZ` | `America/Sao_Paulo` | Timezone for schedules and the prompt |

---

## Security model (read this)

- **The bot has full control of its own container.** Claude runs with `bypassPermissions` and passwordless `sudo`, so it can install anything. It cannot reach the host or the Coolify API, but it can read everything inside its container, including its environment variables. Don't give the container secrets you would not give the assistant.
- **Access control is the number allowlist.** Messages from numbers not in `ALLOWED_NUMBERS`, from groups, channels and statuses are ignored. Whoever controls an allowed number controls the bot.
- **The webhook is internal.** It is reached over the private `coolify` Docker network. Do not add a public domain to the bridge unless you also set `WEBHOOK_HMAC_KEY` (in the bridge's environment and as the HMAC key in WAHA).
- **Internal endpoints** (`/send`, `/send-file`, `/schedules`) only accept connections from `127.0.0.1`, so only processes inside the container can use them.
- **Audit log:** every outgoing message, file sent, and schedule created or deleted is appended to `~/.bridge/audit.log` (JSON lines, in the `claude-home` volume). It records what was sent and to whom, not a full copy of files.
- **Secrets live only in Coolify**, never in the repository. Rotate any token that was ever pasted in a chat or a log: run `claude setup-token` again, change the WAHA API key, and regenerate Coolify API tokens.

---

## Updating

The bridge code lives in this repository. `docker-compose.yml` embeds `bridge/bridge.mjs`, so it must be regenerated after any code change:

1. Edit `bridge/bridge.mjs`.
2. Run `node build-compose.mjs` (it also refuses code that contains a `$`, which Docker Compose would try to interpolate).
3. Run the tests (see below), commit and push.
4. In Coolify, click **Redeploy** on the bridge.

Data (sessions, chat settings, schedules, installed tools, MCP config) lives in the `claude-home` volume and survives redeploys. Thanks to the consistent container name, the webhook keeps working.

---

## Backup and migration

Everything the bot remembers is in the volume `<resource-uuid>_claude-home` (mounted at `/home/node`). On the server:

```bash
# find the volume
docker volume ls | grep claude-home

# back it up (stop the bridge first for a fully consistent copy)
mkdir -p /root/backups
docker run --rm -v <volume>:/data -v /root/backups:/backup node:22-bookworm-slim \
  tar czf /backup/claude-home.tgz -C /data .

# restore into another volume (with the target bridge stopped)
docker run --rm -v <new-volume>:/data -v /root/backups:/backup node:22-bookworm-slim \
  sh -c "cd /data && tar xzf /backup/claude-home.tgz"
```

To move to a new Coolify resource: create it (steps 3 to 5), deploy once so the volume exists, stop it, restore the backup into the new volume, start it again, then update the WAHA webhook (step 7).

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| No reply at all | Check, in order: the bridge is **Running (healthy)**; the WAHA session is `WORKING`; the webhook URL is `http://claude-bridge-claude-zap:3000/webhook` with event `message`; `WAHA_SESSION` matches the session name **exactly**; you are writing **from** a number in `ALLOWED_NUMBERS` **to** the bot's number. |
| Health check from the `coolify` network says `EAI_AGAIN` | The name does not resolve: redo step 5 (predefined network + consistent name) and redeploy. |
| It broke after a redeploy | Container naming went back to "Generated name". Redo step 5 and keep the webhook URL from step 7. |
| `/help` works but questions fail | Claude is not authenticated: check `CLAUDE_CODE_OAUTH_TOKEN`, or generate a new one with `claude setup-token`. |
| Media is not received | Your WAHA edition may not download media (needs WAHA Plus). |
| Schedules do not fire | Check `TZ`; send `/schedules` to confirm the schedule exists; look for `running schedule` in the logs. |
| Playwright or Chromium missing | Ask the bot to install it; `sudo` works and browser files persist in `/home/node`. |

The bridge logs (Coolify → resource → **Logs**) show rejected and ignored messages.

---

## Development and tests

No dependencies: plain Node.js 22.

```bash
node test/run-test.mjs     # fake WAHA + fake Claude: commands, queue, media, schedules
node test/cron-test.mjs    # waits for a minute boundary and checks cron matching
node test/send-test.mjs    # sending to other numbers, /send, files
node build-compose.mjs     # regenerate docker-compose.yml from bridge/bridge.mjs
```

## License

MIT. See [LICENSE](LICENSE).
