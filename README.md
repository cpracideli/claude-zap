# claude-zap

Talk to **Claude Code** from WhatsApp. Send a message to a dedicated WhatsApp number, Claude Code runs on your own server, does the work (research, files, scripts, installs), and replies in the same chat. It can also send messages to other people and run scheduled tasks ("every day at 8am send me the weather").

It runs on [Coolify](https://coolify.io) and uses your **Claude subscription** (no per-token API billing).

```
 Your WhatsApp ──► WAHA (WhatsApp gateway) ──webhook──► claude-zap bridge ──► Claude Code
        ▲                                                       │
        └──────────────────── reply via WAHA ◄──────────────────┘
```

## What you need

| Requirement | Notes |
|---|---|
| A server with **Coolify** (v4) | 2 vCPU / 2 GB RAM is enough. ARM64 and x86_64 both work. |
| A **WAHA** instance, logged in to WhatsApp | Deploy it from Coolify (WAHA one-click service, image `devlikeapro/waha`). Log in with the WhatsApp number the bot will use. Set an API key. |
| A **Claude subscription** (Pro or Max) | Used through `claude setup-token`. |
| A WhatsApp number you control | Ideally a second number used only by the bot. |

## Step-by-step setup

### 1. Deploy WAHA

1. In Coolify, create a service from the **WAHA** template (or a Docker image service with `devlikeapro/waha:latest`).
2. Set the environment variable `WAHA_API_KEY` to a long random value. Keep it.
3. Give it a public domain (Coolify can generate one).
4. Open the WAHA dashboard, create the session `default` and scan the QR code with the bot's WhatsApp.
5. Check that the session status is `WORKING`.

### 2. Get a Claude subscription token

On any computer where you are logged in to Claude Code:

```bash
claude setup-token
```

Copy the token it prints (it starts with `sk-ant-oat01-`). You will paste it into Coolify in step 4. Treat it like a password.

### 3. Create the bridge service in Coolify

1. Open your project and environment, then click **+ New → Docker Compose → Empty**.
2. Paste the contents of `docker-compose.yml` from this repository into the compose editor. If you changed `bridge/bridge.mjs`, run `node build-compose.mjs` first to regenerate it.
3. Save. Do not deploy yet.

### 4. Set the environment variables

In the service's **Environment Variables** tab, add the values below. `.env.example` has the full list.

| Variable | Value |
|---|---|
| `WAHA_URL` | Public URL of your WAHA, e.g. `https://waha.example.com` |
| `WAHA_API_KEY` | The key you set in step 1 |
| `WAHA_SESSION` | `default` (or the session name you created) |
| `ALLOWED_NUMBERS` | Your own number, digits and country code, e.g. `5511999998888`. Several numbers separated by commas. **Only these numbers can use the bot.** |
| `CLAUDE_CODE_OAUTH_TOKEN` | The token from step 2 |
| `TZ` | Your timezone, e.g. `America/Sao_Paulo` (used for schedules) |

Leave `ANTHROPIC_API_KEY` empty if you use the subscription token.

### 5. Deploy

Click **Deploy**. The first start takes a few minutes: it installs `sudo`, basic tools, and Claude Code. Watch the logs; the bridge prints its mode when it starts. Health check: `GET /health` on port 3000.

### 6. Connect WAHA to the bridge (webhook)

1. In the WAHA dashboard, open your session's settings and add a webhook:
   - **URL:** `http://claude-zap:3000/webhook`
   - **Events:** `message`
2. Save. The compose file joins the bridge to Coolify's shared `coolify` Docker network with the fixed alias `claude-zap`, so this internal URL keeps working across redeploys (Coolify appends a timestamp to the container name on every deploy, so don't use the container name).

> WAHA must also be on the `coolify` network. Services created from Coolify templates usually are; if not, enable **Connect to Predefined Network** in WAHA's settings. Run only one claude-zap per server, or change the alias in `build-compose.mjs`.

### 7. Test it

Send `/help` from your allowed number to the bot's WhatsApp. You should get the command list. Then send a question, for example "What's the weather in São Paulo today?"

## Using it

| You send | What happens |
|---|---|
| Any text | Goes to Claude Code. It keeps the conversation context. |
| An image, audio or document | Saved to the inbox; Claude is told the file path and can analyse it. |
| `/new` | Starts a fresh conversation (keeps the model and effort). |
| `/model opus` (or `sonnet`, `haiku`, `padrao`) | Changes the model for this chat. Saved. |
| `/effort high` (`low` … `max`, `padrao`) | Changes the effort level for this chat. Saved. |
| `/status` | Session, model, what is running, queue. |
| `/stop` | Interrupts the current task. The conversation continues. |
| `/enviar +55 11 99999-8888 hello` | Sends a WhatsApp message to another number, directly from the bridge. |
| `/agenda` | Lists scheduled tasks. |
| `/pausar <id>` or `/cancelar <id>` | Pauses (toggles) or deletes a scheduled task. |
| `/help` | Lists the commands. |

**Scheduling** works in plain language: "every day at 8am send me the top AI news" or "remind me tomorrow at 3pm to call John". Claude creates the schedule through the bridge. Scheduled results arrive prefixed with ⏰.

**Sending to others:** you can ask Claude to message a third party ("tell +55 11 98888-7777 I'm 10 minutes late"). Claude writes it as you and confirms afterwards. Replies from that person do not come back to Claude.

## Configuration reference

All settings are environment variables. Full list in `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `WAHA_URL` | (required) | WAHA base URL |
| `WAHA_API_KEY` | (required) | WAHA API key |
| `WAHA_SESSION` | `default` | WAHA session name |
| `ALLOWED_NUMBERS` | (required) | Numbers allowed to use the bot |
| `CLAUDE_CODE_OAUTH_TOKEN` | (empty) | Subscription token (recommended) |
| `ANTHROPIC_API_KEY` | (empty) | Alternative: API key instead of the subscription |
| `CLAUDE_PERMISSION_MODE` | `bypassPermissions` | Claude Code permission mode. Full autonomy inside the container. |
| `CLAUDE_ALLOWED_TOOLS` | `Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,TodoWrite` | Used only if the permission mode is not `bypassPermissions` |
| `CLAUDE_MODEL` | account default | Default model |
| `CLAUDE_EFFORT` | account default | Default effort |
| `CLAUDE_TIMEOUT_SECONDS` | `1800` | Max duration of one task |
| `TZ` | `America/Sao_Paulo` | Timezone for schedules and the prompt |

## Security model (read this)

- **The bot has full control of its container.** Claude runs with `bypassPermissions` and passwordless `sudo`, so it can install anything, including MCP servers and packages. This is intentional for a personal assistant. It cannot reach the host server or the Coolify API, but it can read everything inside its own container, including its environment variables. Do not give the container secrets you would not give the assistant.
- **Access control is the number allowlist.** Messages from numbers not in `ALLOWED_NUMBERS` are ignored, and group messages are ignored. Anyone who controls an allowed number controls the bot.
- **Secrets stay in Coolify**, in environment variables. Never commit `.env` files or tokens. This repository contains no secrets.
- **Internal endpoints** (`/send`, `/send-file`, `/schedules`) accept connections only from `127.0.0.1`, so only processes inside the container can use them.
- **Rotate tokens** if they are ever pasted in a chat or a log: regenerate the Coolify API token, run `claude setup-token` again, and rotate the WAHA API key.

## Updating

The bridge runs from a file stored inside the Coolify service. To update:

1. Edit `bridge/bridge.mjs` in this repository, then run `node build-compose.mjs`.
2. In Coolify, open the service's **Persistent Storage → Files** tab and replace the content of `bridge.mjs` with the new version (or paste the new compose).
3. Click **Restart**.

Your data (sessions, schedules, chat settings, installed tools) lives in the `claude-home` volume and survives restarts and updates.

## Troubleshooting

| Symptom | Check |
|---|---|
| No reply at all | `GET /health` on the bridge returns OK? WAHA session is `WORKING`? Webhook URL and `message` event configured? Your number is in `ALLOWED_NUMBERS`? |
| Claude not authenticated | `CLAUDE_CODE_OAUTH_TOKEN` is set and valid. Generate a new one with `claude setup-token`. |
| Media not received | Some WAHA editions need a paid tier to download media. |
| Schedules do not fire | Check `TZ` and the logs for `running schedule`. Use `/agenda` to confirm the entry exists. |
| Playwright or Chromium missing | Ask the bot to install it. `sudo` works, and browser installs persist in `/home/node`. |

## Development and tests

No dependencies: plain Node.js 22.

```bash
node test/run-test.mjs     # fake WAHA + fake Claude: commands, queue, media, schedules
node test/cron-test.mjs    # waits for a minute boundary and checks cron matching
node test/send-test.mjs    # WhatsApp sending: number checks, /enviar, files
```

## License

MIT. See [LICENSE](LICENSE).
