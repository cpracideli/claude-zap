import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const bridge = fs.readFileSync(path.join(dir, 'bridge', 'bridge.mjs'), 'utf8');
if (bridge.includes('$')) throw new Error('bridge.mjs contains a dollar sign');
const indented = bridge.split('\n').map((l) => (l ? '          ' + l : '')).join('\n');
const D = '$';

function bridgeServiceYaml({ isStack = false } = {}) {
  const panelInternal = isStack
    ? `${D}{PANEL_INTERNAL_URL:-http://agent-control:3001}`
    : `${D}{PANEL_INTERNAL_URL}`;
  return `  claude-bridge:
    image: node:22-bookworm-slim
    user: root
    working_dir: /home/node
    command:
      - sh
      - -c
      - |
        if ! command -v sudo >/dev/null 2>&1; then
          apt-get update && apt-get install -y --no-install-recommends sudo git curl wget ca-certificates gnupg unzip python3 python3-pip python3-venv jq ripgrep procps build-essential openssl ffmpeg poppler-utils espeak-ng zstd xvfb x11vnc novnc websockify fluxbox xdotool scrot
          apt-get install -y --no-install-recommends chromium gh fonts-liberation fonts-noto-color-emoji || true
        fi
        echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node && chmod 440 /etc/sudoers.d/node
        touch /home/node/.apt-packages && chown node:node /home/node /home/node/.apt-packages
        if [ -s /home/node/.apt-packages ]; then
          apt-get update && xargs -a /home/node/.apt-packages apt-get install -y || echo 'apt-packages: some packages failed'
        fi
        exec runuser -u node -- sh -c 'command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code; exec node /app/bridge.mjs'
    environment:
      - HOME=/home/node
      - NPM_CONFIG_PREFIX=/home/node/.npm-global
      - PATH=/home/node/.npm-global/bin:/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      - PORT=3000
      - OWNER_NAME=${D}{OWNER_NAME}
      - STARTUP_NOTICE=${D}{STARTUP_NOTICE}
      - PANEL_INTERNAL_URL=${panelInternal}
      - WAHA_URL=${D}{WAHA_URL}
      - WAHA_SESSION=${D}{WAHA_SESSION:-default}
      - WAHA_API_KEY=${D}{WAHA_API_KEY}
      - ALLOWED_NUMBERS=${D}{ALLOWED_NUMBERS}
      - WHATSAPP_ALLOW_THIRD_PARTY=${D}{WHATSAPP_ALLOW_THIRD_PARTY:-true}
      - ANTHROPIC_API_KEY=${D}{ANTHROPIC_API_KEY}
      - CLAUDE_CODE_OAUTH_TOKEN=${D}{CLAUDE_CODE_OAUTH_TOKEN}
      - CLAUDE_PERMISSION_MODE=${D}{CLAUDE_PERMISSION_MODE:-bypassPermissions}
      - CLAUDE_ALLOWED_TOOLS=${D}{CLAUDE_ALLOWED_TOOLS:-Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,TodoWrite}
      - CLAUDE_MODEL=${D}{CLAUDE_MODEL}
      - CLAUDE_TIMEOUT_SECONDS=${D}{CLAUDE_TIMEOUT_SECONDS:-1800}
      - CLAUDE_EFFORT=${D}{CLAUDE_EFFORT}
      - TZ=${D}{TZ:-America/Sao_Paulo}
      - WEBHOOK_HMAC_KEY=${D}{WEBHOOK_HMAC_KEY}
      - BRIDGE_ADMIN_TOKEN=${D}{BRIDGE_ADMIN_TOKEN}
      - VAULT_KEY=${D}{VAULT_KEY}
      - AI_MEMORY=${D}{AI_MEMORY:-on}
      - AI_MEMORY_SERVER_URL=${D}{AI_MEMORY_SERVER_URL:-http://127.0.0.1:49374}
      - GROQ_API_KEY=${D}{GROQ_API_KEY}
      - GEMINI_API_KEY=${D}{GEMINI_API_KEY}
      - OPENAI_API_KEY=${D}{OPENAI_API_KEY}
      - TTS_MODEL=${D}{TTS_MODEL}
      - TTS_VOICE=${D}{TTS_VOICE}
      - STT_LANGUAGE=${D}{STT_LANGUAGE}
      - AGENTMAIL_API_KEY=${D}{AGENTMAIL_API_KEY}
      - AGENTMAIL_INBOX=${D}{AGENTMAIL_INBOX}
      - TELEGRAM_BOT_TOKEN=${D}{TELEGRAM_BOT_TOKEN}
      - TELEGRAM_ALLOWED_USERS=${D}{TELEGRAM_ALLOWED_USERS}
      - DISCORD_BOT_TOKEN=${D}{DISCORD_BOT_TOKEN}
      - DISCORD_ALLOWED_USERS=${D}{DISCORD_ALLOWED_USERS}
      - SLACK_BOT_TOKEN=${D}{SLACK_BOT_TOKEN}
      - SLACK_SIGNING_SECRET=${D}{SLACK_SIGNING_SECRET}
      - SLACK_ALLOWED_USERS=${D}{SLACK_ALLOWED_USERS}
      - OBSIDIAN_DIR=${D}{OBSIDIAN_DIR}
      - DISABLE_AUTOUPDATER=1
    volumes:
      - claude-home:/home/node
      - type: bind
        source: ./bridge/bridge.mjs
        target: /app/bridge.mjs
        content: |
${indented}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 300s
    restart: unless-stopped`;
}

const compose = `services:
${bridgeServiceYaml({ isStack: false })}
volumes:
  claude-home:
`;

const stackCompose = `services:
${bridgeServiceYaml({ isStack: true })}
  agent-control:
    image: node:22-alpine
    depends_on:
      - claude-bridge
    expose:
      - "3001"
    working_dir: /app
    command:
      - sh
      - -c
      - |
        apk add --no-cache git
        REPO="${D}{PANEL_REPO:-https://github.com/cpracideli/agent-control-panel.git}"
        BRANCH="${D}{PANEL_BRANCH:-main}"
        if [ ! -d /app/.git ]; then
          rm -rf /app/.tmp-clone && git clone --depth 1 --branch "${D}BRANCH" "${D}REPO" /app/.tmp-clone && cp -a /app/.tmp-clone/. /app/ && rm -rf /app/.tmp-clone
        else
          git -C /app remote set-url origin "${D}REPO"
          git -C /app fetch --depth 1 origin "${D}BRANCH" && git -C /app reset --hard FETCH_HEAD
        fi
        SHA="${D}(git -C /app rev-parse HEAD)"
        if [ ! -f /app/dist/index.html ] || [ "${D}(cat /app/.built-sha 2>/dev/null)" != "${D}SHA" ]; then
          cd /app && npm ci && npm run build && echo "${D}SHA" > /app/.built-sha
        fi
        exec node /app/server.js
    environment:
      - PORT=3001
      - BRIDGE_URL=${D}{BRIDGE_URL:-http://claude-bridge:3000}
      - BRIDGE_ADMIN_TOKEN=${D}{BRIDGE_ADMIN_TOKEN}
      - ADMIN_PASSWORD=${D}{ADMIN_PASSWORD}
      - SESSION_SECRET=${D}{SESSION_SECRET}
      - PUBLIC_URL=${D}{PUBLIC_URL}
      - VAPID_SUBJECT=${D}{VAPID_SUBJECT}
      - GOOGLE_OAUTH_CLIENT_ID=${D}{GOOGLE_OAUTH_CLIENT_ID}
      - GOOGLE_OAUTH_CLIENT_SECRET=${D}{GOOGLE_OAUTH_CLIENT_SECRET}
      - ALLOWED_AUTH_EMAILS=${D}{ALLOWED_AUTH_EMAILS}
      - COOLIFY_URL=${D}{COOLIFY_URL}
      - COOLIFY_TOKEN=${D}{COOLIFY_TOKEN}
      - COOLIFY_APP_UUID=${D}{COOLIFY_APP_UUID}
      - PANEL_REPO=${D}{PANEL_REPO:-https://github.com/cpracideli/agent-control-panel.git}
      - PANEL_BRANCH=${D}{PANEL_BRANCH:-main}
    volumes:
      - panel-app:/app
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3001/api/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 180s
    restart: unless-stopped
volumes:
  claude-home:
  panel-app:
`;

fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
fs.writeFileSync(path.join(dir, 'docker-compose.stack.yml'), stackCompose);
fs.writeFileSync(path.join(dir, 'compose.b64'), Buffer.from(compose).toString('base64'));
console.log('ok', compose.length, 'bytes (docker-compose.yml) |', stackCompose.length, 'bytes (docker-compose.stack.yml)');
