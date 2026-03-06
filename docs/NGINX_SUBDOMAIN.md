# Nginx Subdomain Setup (`tunnel.yourdomain.com`)

## 1. DNS

Create an `A` record:
- Host: `tunnel`
- Value: `YOUR_SERVER_IP`

Optional wildcard for public routed hosts:
- Host: `*`
- Value: `YOUR_SERVER_IP`

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
Environment=REQUEST_TIMEOUT_MS=30000`r`n# Optional one-time admin bootstrap`r`nEnvironment=INITIAL_ADMIN_USERNAME=admin`r`nEnvironment=INITIAL_ADMIN_PASSWORD=change-me-now

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

## 4. Nginx Config

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

Enable + reload:

```bash
sudo ln -s /etc/nginx/sites-available/tunnel.yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 5. TLS

```bash
sudo certbot --nginx -d tunnel.yourdomain.com
```

## 6. Client Example

```bash
bun run dev:client -- --server wss://tunnel.yourdomain.com/_tunnel_connect --token YOUR_TOKEN
```




Note: client tokens are obtained via --register or --login and then passed with --token.


