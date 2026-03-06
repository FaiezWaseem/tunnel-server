# Nginx + Certbot Recovery Guide (Safe for Existing Sites)

## 1. Backup First

```bash
sudo cp -a /etc/nginx /etc/nginx.backup.$(date +%F-%H%M)
```

## 2. Diagnose

```bash
sudo nginx -t
sudo nl -ba /etc/nginx/sites-enabled/default.conf | sed -n '1,200p'
sudo systemctl status nginx --no-pager -l
```

If you see errors like:
- `no "ssl_certificate" is defined for the "listen ... ssl" directive`
- malformed blocks like `}server {`

then fix config before reloading.

## 3. Fast Reset Path

```bash
BACKUP=$(ls -dt /etc/nginx.backup.* | head -n1)
echo "$BACKUP"
sudo systemctl stop nginx
sudo rm -rf /etc/nginx
sudo cp -a "$BACKUP" /etc/nginx
sudo nginx -t
sudo systemctl start nginx
sudo systemctl status nginx --no-pager
```

## 4. Isolated Tunnel Config (Recommended)

Do not edit crowded `default.conf`. Use dedicated file:

```bash
sudo tee /etc/nginx/sites-available/tunnel.faiezwaseem.site.conf > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name tunnel.faiezwaseem.site;

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
EOF

sudo ln -sf /etc/nginx/sites-available/tunnel.faiezwaseem.site.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Start with HTTP (`ws://`) first. Add TLS after basic routing works.

## 5. Certbot Install/Attach

```bash
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d tunnel.faiezwaseem.site
```

If cert already exists but not installed:

```bash
sudo certbot install --cert-name tunnel.faiezwaseem.site
```

## 6. Auto-Configure Script (From This Repo)

Script path:
- `scripts/configure-nginx-tunnel.sh`

Use it:

```bash
sudo bash scripts/configure-nginx-tunnel.sh --domain faiezwaseem.site
```

With certbot:

```bash
sudo bash scripts/configure-nginx-tunnel.sh --domain faiezwaseem.site --certbot
```

Help:

```bash
sudo bash scripts/configure-nginx-tunnel.sh --help
```
