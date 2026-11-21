# BotBulls (`botbulls.com`) — Free Database & 1-Upload Hosting Guide

## Step 1: Free PostgreSQL Database Banayein (5 Minutes)
Aap niche diye gaye kisi bhi **FREE** platform par PostgreSQL database bana sakte hain:

1. **Neon (Best Free Option — Recommended):** https://neon.com/pricing
   - Sign up karein → **Create Project** (`botbulls-db`) → **Connection String** (`postgresql://...`) copy kar lein.
   - Neon Free Plan mein 1 GB PostgreSQL storage milti hai aur database 30 din mein delete nahi hota.
2. **Supabase (Free Option):** https://supabase.com/pricing
   - New Project banayein → **Project Settings → Database → Connection String (URI)** copy karein.
   - Built-in SQL Editor mein `database/schema.sql` paste karke Run kar sakte hain (ya `npm run db:init` chalayein).

---

## Step 2: Hosting Par Folder Upload Karein (2 Aasan Tarike)

### Tarika A — Sabse Aasan (Hostinger / GoDaddy / cPanel Shared Hosting)
Agar aapne normal web hosting (cPanel / hPanel) li hai:
1. Apne hosting File Manager mein **`public_html`** folder kholein.
2. Is zip ke andar ke **`public_html/`** folder ki dono files (`index.html` aur `.htaccess`) seedha wahan upload kar dein.
3. Domain `botbulls.com` connect karte hi aapki website turant live chalne lagegi!

### Tarika B — Full-Stack (Node.js + Free PostgreSQL on Render / Railway / cPanel Node.js)
Agar aapko live database + API + website sab ek saath chalana hai:
1. **Render** (https://render.com/docs/free) par free account banayein (ya cPanel mein **Setup Node.js App** kholein).
2. Is poore `botbulls-deploy-ready` folder ko upload karein (ya GitHub repo mein push karke Render par **New → Web Service** select karein).
3. Environment Variables mein add karein:
   - `DATABASE_URL` = aapka Neon / Supabase PostgreSQL URI
   - `JWT_SECRET` = koi bhi random secret string
   - `CORS_ORIGIN` = `https://botbulls.com`
4. Build Command: `npm install` | Start Command: `npm start`
5. First time tables & Partners Log account (`admin` / `ayaz1104`) banane ke liye run karein:
   `npm run db:init`
6. Render / Hosting settings mein apna custom domain **`botbulls.com`** add karein (free SSL automatically mil jayega).
