# BotBulls v5.0 (`botbulls.com`) — Self-Hosted VPS & Custom Domain Deployment Guide

This package is ready to deploy directly on your own **Ubuntu 22.04 / 24.04 VPS** (Hostinger VPS, DigitalOcean, Contabo, AWS Lightsail, Hetzner, Linode) with custom domain **`botbulls.com`**, free **Let's Encrypt HTTPS/SSL**, **PostgreSQL**, **Nginx**, **PM2**, **Automated SMTP**, and **Exchange/Wallet APIs**.

---

## 1. Point Your Domain (`botbulls.com`) DNS to Your VPS

In your domain registrar (GoDaddy, Namecheap, Hostinger, or Cloudflare DNS), create two **A Records**:

| Type | Name / Host | Value | TTL |
| :--- | :--- | :--- | :--- |
| `A` | `@` | `YOUR_VPS_IPV4_ADDRESS` | Auto / 300 |
| `A` | `www` | `YOUR_VPS_IPV4_ADDRESS` | Auto / 300 |

---

## 2. Upload Code & Run One-Click VPS Setup

1. Connect to your VPS via SSH:
   ```bash
   ssh root@YOUR_VPS_IPV4_ADDRESS
   ```
2. Upload and unzip `botbulls-v5-production.zip` (or `git clone` your GitHub repo) into `/root/botbulls-production`.
3. Run the automated setup script:
   ```bash
   cd /root/botbulls-production
   sudo bash deploy/setup-vps.sh
   ```
   This automatically installs **Node.js 20**, **PostgreSQL**, **Nginx**, **Certbot**, **UFW Firewall**, creates the `botbulls_db` database, initializes all **14 PostgreSQL tables** (`database/schema.sql`), starts the app under **PM2** (`botbulls-app`), and configures the Nginx reverse proxy.

---

## 3. Configure `.env` (SMTP Email & Exchange APIs)

Open `/var/www/botbulls/.env`:
```bash
nano /var/www/botbulls/.env
```
- **SMTP Email:** Fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM="BotBulls <no-reply@botbulls.com>"`.
- **Exchange / Crypto Wallet API (Optional):** Set `EXCHANGE_PROVIDER` to `LIQUIDITY_API_A`, `LIQUIDITY_API_B`, or `CUSTOM`, set `EXCHANGE_MODE=LIVE` (or `SANDBOX` to test first), and fill `EXCHANGE_API_KEY`, `EXCHANGE_API_SECRET`, and `EXCHANGE_API_PASSPHRASE` (for Liquidity API B). You can also manage these inside **Control Console → Exchange / Wallet API**.
- Save and restart PM2:
  ```bash
  pm2 restart botbulls-app
  pm2 logs botbulls-app --lines 30
  ```

---

## 4. Enable Free HTTPS / SSL Certificate (`https://botbulls.com`)

Once DNS propagates (usually 5–15 minutes), run:
```bash
sudo certbot --nginx -d botbulls.com -d www.botbulls.com
```
Certbot automatically issues and auto-renews your free SSL certificate and redirects `http://` → `https://botbulls.com`.

---

## 5. Verify Your Live Platform

- **Health Check API:** `https://botbulls.com/api/health` → confirms `version: "5.0.0"`, `storage: "postgresql"`, `smtpConfigured`, and `exchangeProvider`.
- **Public Website:** `https://botbulls.com/`
- **Referral Signup Link:** `https://botbulls.com/?ref=BBREF1001`
- **Separate Control Console:** `https://botbulls.com/control` or `https://botbulls.com/#/control` (`ops_desk` / `Videocon007tV`).
