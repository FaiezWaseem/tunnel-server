# Nginx Subdomain Setup (`tunnel.yourdomain.com` + `*.yourdomain.com`)

For this tunnel architecture, use two hostnames:
- Control plane: `tunnel.yourdomain.com` (client WebSocket/API)
- Data plane: `*.yourdomain.com` (public traffic like `test.yourdomain.com`)

## 1. DNS

Create these `A` records:
- Host: `tunnel` -> `YOUR_SERVER_IP`
- Host: `*` -> `YOUR_SERVER_IP`

## 2. Bun Service

Create `/etc/systemd/system/tunnel-server.service`:

```ini
[Unit]
Description=Bun Tunnel Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/tunnel-server
ExecStart=/usr/local/bin/bun run dev:server
Restart=always
RestartSec=3
Environment=PORT=8080
Environment=DOMAIN=yourdomain.com
Environment=DB_PATH=./data/tunnel.db
Environment=REQUEST_TIMEOUT_MS=30000
# Optional one-time admin bootstrap
Environment=INITIAL_ADMIN_USERNAME=admin
Environment=INITIAL_ADMIN_PASSWORD=change-me-now

[Install]
WantedBy=multi-user.target
```

Enable:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tunnel-server
```

## 3. Install Nginx + Certbot

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 4. Nginx Virtual Hosts

### 4.1 Control plane vhost (`tunnel.yourdomain.com`)

Create `/etc/nginx/sites-available/tunnel.yourdomain.com`:

```nginx
server {
    listen 80;
    server_name tunnel.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

### 4.2 Data plane wildcard vhost (`*.yourdomain.com`)

Create `/etc/nginx/sites-available/wildcard.yourdomain.com`:

```nginx
server {
    listen 80;
    server_name .yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable + reload:

```bash
sudo ln -s /etc/nginx/sites-available/tunnel.yourdomain.com /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/wildcard.yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 5. TLS

Control plane cert:

```bash
sudo certbot --nginx -d tunnel.yourdomain.com
```

Wildcard cert typically needs DNS challenge (`*.yourdomain.com`).

## 6. Client Example

```bash
bun run dev:client -- --server wss://tunnel.yourdomain.com/_tunnel_connect
```

Note: tokens are obtained via `--register`/`--login` and reused from saved session (or pass `--token`).

## 7. Important Note

`server.ts` cannot auto-create Nginx vhosts. Nginx routing happens before requests reach Bun, so these vhosts must be configured on the server.
