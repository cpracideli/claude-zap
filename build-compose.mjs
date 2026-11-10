import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const bridge = fs.readFileSync(path.join(dir, 'bridge', 'bridge.mjs'), 'utf8');
if (bridge.includes('$')) throw new Error('bridge.mjs contains a dollar sign');
const indented = bridge.split('\n').map((l) => (l ? '          ' + l : '')).join('\n');
const D = '$';
const compose = `services:
  claude-bridge:
    image: node:22-bookworm-slim
    user: root
    working_dir: /home/node
    command:
      - sh
      - -c
      - |
        if ! command -v sudo >/dev/null 2>&1; then
          apt-get update && apt-get install -y --no-install-recommends sudo git curl wget ca-certificates gnupg unzip python3 python3-pip python3-venv jq ripgrep procps build-essential
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
      - PATH=/home/node/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      - PORT=3000
      - WAHA_URL=${D}{WAHA_URL}
      - WAHA_SESSION=${D}{WAHA_SESSION:-default}
      - WAHA_API_KEY=${D}{WAHA_API_KEY}
      - ALLOWED_NUMBERS=${D}{ALLOWED_NUMBERS}
      - ANTHROPIC_API_KEY=${D}{ANTHROPIC_API_KEY}
      - CLAUDE_CODE_OAUTH_TOKEN=${D}{CLAUDE_CODE_OAUTH_TOKEN}
      - CLAUDE_PERMISSION_MODE=${D}{CLAUDE_PERMISSION_MODE:-bypassPermissions}
      - CLAUDE_ALLOWED_TOOLS=${D}{CLAUDE_ALLOWED_TOOLS:-Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,TodoWrite}
      - CLAUDE_MODEL=${D}{CLAUDE_MODEL}
      - CLAUDE_TIMEOUT_SECONDS=${D}{CLAUDE_TIMEOUT_SECONDS:-1800}
      - CLAUDE_EFFORT=${D}{CLAUDE_EFFORT}
      - TZ=${D}{TZ:-America/Sao_Paulo}
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
    restart: unless-stopped
    networks:
      default: {}
      coolify:
        # Stable name for the WAHA webhook: http://claude-zap:3000/webhook
        # (Coolify adds a timestamp to the container name on every deploy).
        aliases:
          - claude-zap
volumes:
  claude-home:
networks:
  coolify:
    external: true
`;
fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
fs.writeFileSync(path.join(dir, 'compose.b64'), Buffer.from(compose).toString('base64'));
console.log('ok', compose.length, 'bytes');
