# BotBulls v2.0 (`botbulls.com`) — GitHub-Ready Full-Stack Platform

## Folder Structure
```text
botbulls-v2/
├── public_html/
│   ├── index.html             # Complete Responsive Frontend (Public Site, User Terminal, Admin Portal)
│   └── .htaccess              # HTTPS & SPA routing for cPanel / Apache hosting
├── database/
│   └── schema.sql             # 12-Table PostgreSQL Schema
├── server.js                  # Express API + Static SPA + Real-Time State Sync
├── emailService.js            # Free SMTP / Nodemailer Service (5 Automated Templates)
├── init-db.js                 # Database Initializer & Reward Milestone Seeder
├── package.json               # Node.js Dependencies (Express, pg, bcryptjs, nodemailer, helmet)
├── render.yaml                # 1-Click Render Cloud Deployment Blueprint
├── .env.example               # Database & Free SMTP Configuration Template
└── ARCHITECTURE_AND_SECURITY.md
```

## Quick Start (GitHub → Render / VPS / cPanel Node.js)
1. Upload this folder directly to your GitHub repository.
2. Create a free PostgreSQL database on **Supabase** or **Neon** and copy your `DATABASE_URL`.
3. Configure Free SMTP (e.g., Gmail App Password or Brevo) in `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`).
4. Run `npm install`, then `npm start` (and optionally `npm run db:init` once to seed PostgreSQL tables).
5. Access the isolated Admin Portal at `/#/admin` with username `admin` and password `ayaz1104`.
