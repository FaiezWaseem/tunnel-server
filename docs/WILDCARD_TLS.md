# Wildcard TLS for Tunnel Subdomains

This guide enables HTTPS for public tunnel hosts like:

- `https://test.tunnel.faiezwaseem.site`
- `https://abc123.tunnel.faiezwaseem.site`

This is different from the control-plane host:

- `https://tunnel.faiezwaseem.site`

## Why This Is Needed

If your server uses:

- `DOMAIN=tunnel.faiezwaseem.site`

So when a client requests subdomain `test`, the final public host becomes:

- `test.tunnel.faiezwaseem.site`

then Nginx needs:

1. A wildcard certificate for `*.tunnel.faiezwaseem.site`
2. A wildcard HTTPS server block

If you switch to the cleaner layout:

- control plane: `tunnel.faiezwaseem.site`
- public tunnels: `test.faiezwaseem.site`
- server env: `DOMAIN=faiezwaseem.site`

then your existing wildcard certificate for `*.faiezwaseem.site` can be reused and this guide is no longer needed for public tunnel HTTPS.

## 1. Request Wildcard Certificate

Use Certbot with DNS challenge:

```bash
sudo certbot certonly \
  --manual \
  --preferred-challenges dns \
  -d "*.tunnel.faiezwaseem.site" \
  -d "tunnel.faiezwaseem.site"
```

Certbot will print TXT records that must be added in your DNS.

Typical records look like:

```text
_acme-challenge.tunnel.faiezwaseem.site
```

Wait for DNS propagation, then continue the Certbot flow.

Important:

- Do not press `Enter` in Certbot until the TXT record is visible publicly.
- For this certificate request, the validation record is:

```text
_acme-challenge.tunnel.faiezwaseem.site
```

- If Certbot says `No TXT record found`, it means the record was not created yet, was created in the wrong DNS zone, or had not propagated before you continued.

## 1.1 Verify TXT Before Pressing Enter

After adding the TXT record in your DNS provider, verify it from the server:

```bash
dig +short TXT _acme-challenge.tunnel.faiezwaseem.site
```

Or:

```bash
nslookup -type=TXT _acme-challenge.tunnel.faiezwaseem.site
```

Only press `Enter` in the Certbot prompt after the returned TXT value matches the value Certbot gave you exactly.

If DNS is slow, wait a few minutes and check again.

## 2. Find Certificate Paths

After issuance, Certbot will print the actual certificate path.

Usually:

```text
/etc/letsencrypt/live/tunnel.faiezwaseem.site/fullchain.pem
/etc/letsencrypt/live/tunnel.faiezwaseem.site/privkey.pem
```

But use the exact path Certbot gives you.

## 3. Add Wildcard HTTPS Server Block

Edit your tunnel Nginx config and add:

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name *.tunnel.faiezwaseem.site;

    ssl_certificate /etc/letsencrypt/live/tunnel.faiezwaseem.site/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tunnel.faiezwaseem.site/privkey.pem;

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

If you also want HTTP to redirect to HTTPS for wildcard hosts, add:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name *.tunnel.faiezwaseem.site;
    return 301 https://$host$request_uri;
}
```

## 4. Test and Reload Nginx

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## 5. Verify

After a client connects with subdomain `test`, this should work:

```bash
curl -I https://test.tunnel.faiezwaseem.site
```

## Notes

- The control host certificate alone is not enough for wildcard public tunnel hosts.
- `*.tunnel.faiezwaseem.site` requires DNS challenge; HTTP challenge is not sufficient for wildcard certificates.
- If you later change `DOMAIN`, the wildcard certificate scope must match the new final tunnel hostname pattern.
- For manual DNS challenge, pressing `Enter` too early will fail validation immediately.
