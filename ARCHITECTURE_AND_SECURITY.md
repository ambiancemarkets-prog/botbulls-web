# BotBulls v2.0 (`botbulls.com`) — Architecture, Business Rules & Security

## 1. Core Platform Rules
- **90-Day Validity:** Every activated plan is valid for 90 calendar days (3 months) tracked daily at 12:00 AM IST; after Day 90, payouts cease permanently.
- **Tiered Monthly Bot Pricing:**
  - `$50–$400` Plans → **$25 USD / month** Bot
  - `$500–$1,000` Plans → **$50 USD / month** Bot
- **Strict No-Retroactive Payout Rule:** Daily distributions (base **5%**, admin-configurable `1%–10%` in tranches) and daily **GWC** accrue ONLY on days when BOTH the Plan (within 90 days) and the current-month Bot (`botExpiresAt > now`) are active. Renewing a bot late (e.g., 5 days late) resumes distributions strictly forward from the renewal day with zero backdated credit.
- **Daily 5-Level 5% GWC (Goodwill Commission):** A 5.00% daily GWC pool (`L1: 2.00%`, `L2: 1.25%`, `L3: 0.75%`, `L4: 0.60%`, `L5: 0.40%`) is distributed daily to active uplines whenever active downlines receive daily payouts.
- **Company Gifts & Rewards (5% Pool):** Tracks cumulative business across the user + 5 downline levels from **₹1 Lakh (Wrist Watch)** through **₹1 Crore (Car)**.
- **Withdrawals:** Strict **$10.00 USD minimum** and **1% withdrawal deduction** enforced server-side.
- **Automated Emails:** Nodemailer SMTP module (`emailService.js`) supporting Welcome, Daily Payout & GWC, Deposit Status, Withdrawal Status, and Forgot Password OTP emails.

## 2. Security & Anti-Copy Architecture
- **Server-Side Controls:** `bcryptjs` password hashing, JWT + RBAC middleware for `/api/admin/*`, `helmet` security headers, `express-rate-limit`, PostgreSQL row-level locking (`SELECT ... FOR UPDATE`), XSS text sanitization, and IP audit logging (`audit_logs`).
- **Anti-Copy Reality:** Frontend deterrents (production bundling, disabled right-click/selection on proprietary chrome) only discourage casual copying because browser HTML/JS can always be inspected. All critical balance checks, $10 minimum withdrawal rules, 1% deductions, monthly bot expiry checks, and Admin RBAC MUST remain enforced on the backend server.
