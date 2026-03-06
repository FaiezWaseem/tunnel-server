# Apache Subdomain Setup (`tunnel.yourdomain.com`)

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

## 3. Install Apache + Certbot

```bash
sudo apt update
sudo apt install -y apache2 certbot python3-certbot-apache
sudo a2enmod proxy proxy_http proxy_wstunnel headers rewrite ssl
sudo systemctl restart apache2
```

## 4. Apache VirtualHost

Create `/etc/apache2/sites-available/tunnel.yourdomain.com.conf`:

```apache
<VirtualHost *:80>
    ServerName tunnel.yourdomain.com

    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "http"

    ProxyPass "/_tunnel_connect" "ws://127.0.0.1:8080/_tunnel_connect"
    ProxyPassReverse "/_tunnel_connect" "ws://127.0.0.1:8080/_tunnel_connect"

    ProxyPass "/" "http://127.0.0.1:8080/"
    ProxyPassReverse "/" "http://127.0.0.1:8080/"
</VirtualHost>
```

Enable + reload:

```bash
sudo a2ensite tunnel.yourdomain.com.conf
sudo apachectl configtest
sudo systemctl reload apache2
```

## 5. TLS

```bash
sudo certbot --apache -d tunnel.yourdomain.com
```

## 6. Client Example

```bash
bun run dev:client -- --server wss://tunnel.yourdomain.com/_tunnel_connect --token YOUR_TOKEN
```




Note: client tokens are obtained via --register or --login and then passed with --token.


