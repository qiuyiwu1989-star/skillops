# Skill Hub · Try API

In-browser chat backend for skill.qiuyiwu.com. Lets users try a skill
without installing it locally.

## Architecture

```
browser → https://skill.qiuyiwu.com/api/try/innolab
            ↓ nginx reverse proxy
         127.0.0.1:8787 (this Node.js service)
            ↓
         LLM (any OpenAI-compatible endpoint via env)
```

## Local dev

```sh
cp .env.example .env
# edit .env with real key, base url, model
export $(grep -v '^#' .env | xargs)
npm start
# → http://127.0.0.1:8787/health
```

Test it without a real LLM key first:
```sh
curl http://127.0.0.1:8787/health
# {"ok":true,...}
curl http://127.0.0.1:8787/skills
# {"skills":["innolab",...]}
```

## Production deploy (Tencent VPS)

```sh
# 1. Install Node.js 20+ on the VPS
ssh -i ~/.ssh/id_ed25519_skill_deploy ubuntu@43.159.171.3
sudo apt update && sudo apt install -y nodejs npm
sudo node --version  # should be ≥ 18

# 2. Sync this folder to /opt/skill-api
rsync -avz --exclude='.env' --exclude='node_modules' \
  -e "ssh -i ~/.ssh/id_ed25519_skill_deploy" \
  api-server/ ubuntu@43.159.171.3:/tmp/skill-api/
ssh -i ~/.ssh/id_ed25519_skill_deploy ubuntu@43.159.171.3 \
  'sudo mv /tmp/skill-api /opt/skill-api && sudo chown -R ubuntu:ubuntu /opt/skill-api'

# 3. Create the .env file on server (NOT in this repo)
sudo mkdir -p /etc/skill-api
sudo nano /etc/skill-api/.env   # paste real config from .env.example template
sudo chmod 600 /etc/skill-api/.env

# 4. Install as systemd service
sudo cp /opt/skill-api/skill-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now skill-api
sudo systemctl status skill-api

# 5. Reverse proxy via nginx (add the snippet to the skill.qiuyiwu.com vhost)
sudo nano /etc/nginx/sites-enabled/qiuyiwu.com
# paste contents of nginx-snippet.conf inside the skill.qiuyiwu.com server block
sudo nginx -t && sudo systemctl reload nginx

# 6. Verify
curl https://skill.qiuyiwu.com/api/health
# {"ok":true,...}
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | Liveness |
| `GET`  | `/skills` | List installable skill slugs |
| `GET`  | `/try/:slug/remaining` | Check IP quota (no consume) |
| `POST` | `/try/:slug` | Chat with the skill (SSE stream) |

### POST `/try/:slug`

Body:
```json
{
  "messages": [
    { "role": "user", "content": "帮我分析下电动汽车行业" }
  ]
}
```

Response: `text/event-stream` with `token`, `done`, and `error` events.

```
event: token
data: {"t":"我"}

event: token
data: {"t":"用"}

...

event: done
data: {"remaining":2}
```

## Rate limit

- Default: **3 messages per IP per UTC day** (anonymous).
- Stored in-memory (resets on service restart).
- Override via `RATE_LIMIT_PER_IP` env var.
- Future: add login (微信扫码 / 邮箱 magic-link) for higher quotas.

## Security notes

- `LLM_API_KEY` lives ONLY in `/etc/skill-api/.env` (mode 600, ubuntu user).
- Never commit `.env` to git. `.env.example` is the safe template.
- If a key leaks (e.g. pasted in chat), rotate at the LLM provider and update the server's `/etc/skill-api/.env`.
- CORS is locked to `ALLOW_ORIGIN` (default: production hub URL).
