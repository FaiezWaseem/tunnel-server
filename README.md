# Tunnel Server (Bun)

A lightweight reverse tunnel system built with **Bun**:
- `server`: runs on your VPS and receives public HTTP traffic.
- `client`: runs on your local machine, connects over WebSocket, and proxies requests to your local app.

This project supports:
- Subdomain-based routing (`myapp.yourdomain.com`)
- Request/response correlation with request IDs
- User registration and token issuance
- User roles (`admin`, `client`) with default `client` registration role
- Token auth and subdomain ownership for tunnel clients
- Client reconnect with backoff
- Binary-safe payload forwarding via Base64

## Requirements

- [Bun](https://bun.sh) v1.1+
- A domain with wildcard DNS pointing to your VPS (`*.yourdomain.com`)

## Project Structure

- `server/server.ts`: Bun server + WebSocket control channel
- `client/client.ts`: tunnel agent that runs near your local app
- `shared/protocol.ts`: message protocol + validation helpers
- `package.json`: scripts for dev and binary builds

## Configuration

### Server env vars

- `PORT` (default: `8080`)
- `DOMAIN` (default: `example.com`)
- `DB_PATH` (default: `./data/tunnel.db`)
- `REQUEST_TIMEOUT_MS` (default: `30000`)
- `INITIAL_ADMIN_USERNAME` + `INITIAL_ADMIN_PASSWORD` (optional bootstrap admin at startup)

### Client args

- Defaults are loaded from `.env`:
- `TUNNEL_SERVER_URL` (default: `ws://127.0.0.1:8080/_tunnel_connect`)
- `TUNNEL_API_URL` (default: derived from `TUNNEL_SERVER_URL`, e.g. `http://127.0.0.1:8080`)
- `TUNNEL_SUBDOMAIN` (optional; if omitted, client auto-generates one)
- `TUNNEL_LOCAL_URL` (default: `http://127.0.0.1:3000`)
- `TUNNEL_AUTH_TOKEN` (required for tunnel mode)
- `TUNNEL_SESSION_FILE` (optional path for saved login token)
- `TUNNEL_USERNAME` and `TUNNEL_PASSWORD` (for register/login modes)
- `TUNNEL_REVOKE_TOKEN` (optional fallback for revoke mode)
- `--port`, `--p`, or `-p` can be used instead of `--local` (example: `--port 3000` -> `http://127.0.0.1:3000`)
- CLI flags still override env values when provided (`--server`, `--api`, `--subdomain`, `--local`, `--port`, `--p`, `-p`, `--token`, `--username`, `--password`, `--revoke-token`).

Token persistence:
- After `--register` or `--login`, client auto-saves token locally and reuses it by default.
- You can still override with `--token`.
- Use `--no-save-token` to disable saving.

## Install

```bash
bun install
```

Create your local env file:

```bash
# PowerShell (Windows)
Copy-Item .env.example .env
```

## Run (Development)

### 1. Start server

```bash
bun run dev:server
```

### 2. Client usage guide

See all options:

```bash
bun run dev:client -- --help
```

Register user and get first token:

```bash
bun run dev:client -- --register --username alice --password "yourStrongPass123"
```

Note: self-registered users are created with `client` role by default.

Login and issue a new token:

```bash
bun run dev:client -- --login --username alice --password "yourStrongPass123"
```

List tokens for your account:

```bash
bun run dev:client -- --list-tokens --token YOUR_ACTIVE_TOKEN
```

Revoke a token:

```bash
bun run dev:client -- --revoke-token TOKEN_TO_REVOKE --token YOUR_ACTIVE_TOKEN
```

Start tunnel with a valid token:

```bash
bun run dev:client -- --token YOUR_ISSUED_TOKEN
```

Start tunnel using auto-saved token (no `--token` needed):

```bash
bun run dev:client
```

Start tunnel by local port shortcut:

```bash
bun run dev:client -- --token YOUR_ISSUED_TOKEN --port 3000
```

Custom subdomain:

```bash
bun run dev:client -- --token YOUR_ISSUED_TOKEN --subdomain myapp
```

Override server/API when needed:

```bash
bun run dev:client -- --token YOUR_ISSUED_TOKEN --server wss://tunnel.yourdomain.com/_tunnel_connect --api https://tunnel.yourdomain.com
```

Now requests sent to host `<subdomain>.example.com` (or with local host header override) are forwarded to your local app.

## Build Client Binaries

```bash
# Windows x64
bun run build:client:win

# Linux x64
bun run build:client:linux

# macOS arm64
bun run build:client:mac
```

Binaries are written into `dist/`.

## Production Notes

- Put Caddy or Nginx in front for TLS (`wss://` and `https://`).
- Keep SQLite DB (`DB_PATH`) backed up.
- Consider adding rate limiting and per-user tunnel ownership.
- Add persistent tunnel/session state if you need HA across multiple server instances.

## Quick Test Flow

1. Run a local app on `http://127.0.0.1:3000`.
2. Start server and client.
3. Send a request with host header:

```bash
curl -H "Host: myapp.example.com" http://127.0.0.1:8080/
```

You should receive your local app response through the tunnel.

## Deployment

See deployment docs:
- [docs/NGINX_DOMAIN.md](docs/NGINX_DOMAIN.md)
- [docs/NGINX_SUBDOMAIN.md](docs/NGINX_SUBDOMAIN.md)
- [docs/NGINX_CERTBOT_RECOVERY.md](docs/NGINX_CERTBOT_RECOVERY.md)
- [docs/APACHE_DOMAIN.md](docs/APACHE_DOMAIN.md)
- [docs/APACHE_SUBDOMAIN.md](docs/APACHE_SUBDOMAIN.md)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (index)

## Nginx Auto-Configure Script

Use the automation script to create isolated Nginx tunnel vhosts safely:

```bash
sudo bash scripts/configure-nginx-tunnel.sh --domain faiezwaseem.site
```

Optional TLS for control-plane host:

```bash
sudo bash scripts/configure-nginx-tunnel.sh --domain faiezwaseem.site --certbot
```

The script uses `certbot certonly --nginx` and manages TLS in the tunnel config itself (it does not let Certbot install into `default.conf`).

Script path:
- [scripts/configure-nginx-tunnel.sh](scripts/configure-nginx-tunnel.sh)

## Nginx Unified Bootstrap Script

For a single \"run-and-go\" command (install + fix + configure + TLS):

```bash
sudo bash scripts/bootstrap-tunnel-nginx.sh --domain faiezwaseem.site
```

Script path:
- [scripts/bootstrap-tunnel-nginx.sh](scripts/bootstrap-tunnel-nginx.sh)
