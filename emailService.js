/**
 * BotBulls v3.0 (botbulls.com) — Automated Email Service (Free SMTP / Nodemailer Ready)
 * Supports Brevo, Outlook, Zoho, Resend, Mailtrap, or any standard SMTP via .env.
 * Templates:
 *   1. WELCOME              — Registration welcome email
 *   2. DAILY_PAYOUT_GWC     — Daily 2.5% distribution & 2.5% 5-level GWC summary
 *   3. BOT_AUTO_RENEWAL     — Automatic monthly bot renewal or insufficient-balance notice
 *   4. DEPOSIT_STATUS       — Deposit Submitted / Approved / Rejected (INR & Crypto)
 *   5. WITHDRAWAL_STATUS    — Withdrawal Requested / Approved / Rejected (0% company deduction; network fee client-borne)
 *   6. FORGOT_PASSWORD      — Password Reset 6-digit OTP
 */

const nodemailer = require('nodemailer');

function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function wrapLayout(title, bodyHtml) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;background:#070b14;color:#e2e8f0;padding:24px;">
      <div style="max-width:560px;margin:0 auto;background:#0d1424;border:1px solid #1e2c48;border-radius:14px;overflow:hidden;">
        <div style="padding:18px 24px;border-bottom:1px solid #1e2c48;background:#111a2e;">
          <strong style="font-size:20px;color:#10b981;">BotBulls</strong>
          <span style="font-size:11px;color:#94a3b8;margin-left:8px;">botbulls.com — World's Trusted Saving Wallet</span>
        </div>
        <div style="padding:24px;line-height:1.6;font-size:14px;">
          <h2 style="margin:0 0 12px;color:#f8fafc;font-size:18px;">${title}</h2>
          ${bodyHtml}
        </div>
        <div style="padding:14px 24px;border-top:1px solid #1e2c48;font-size:11px;color:#64748b;">
          Automated notification from BotBulls (botbulls.com). Please do not reply directly to this email.
        </div>
      </div>
    </div>
  `;
}

const TEMPLATES = {
  WELCOME: ({ fullName, userCode, referralCode }) => ({
    subject: 'Welcome to BotBulls (botbulls.com) — Account Created',
    html: wrapLayout('Welcome to BotBulls!', `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your BotBulls membership account is ready:</p>
      <ul>
        <li><strong>User ID:</strong> ${userCode}</li>
        <li><strong>Referral ID:</strong> ${referralCode}</li>
      </ul>
      <p>Activate any 12-month plan ($50–$1,000) along with the tiered monthly Bot ($10/mo for $50–$400 plans, or $50/mo for $500–$1,000 plans) to receive Mon–Fri hourly staggered distributions (up to 2.5% and more) and daily 5-level 2.5% GWC (Goodwill Commission). Monthly bot renewals are handled automatically from your wallet when sufficient balance is available.</p>
    `),
  }),

  DAILY_PAYOUT_GWC: ({ fullName, payoutUsd, gwcUsd, ratePercent, dateStr }) => ({
    subject: `BotBulls Daily Credit (${dateStr}) — Payout & GWC Summary`,
    html: wrapLayout('Daily Payout & GWC Credit', `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your active BotBulls account has received today's distribution (${dateStr}):</p>
      <ul>
        <li><strong>Daily Distribution (${ratePercent}%):</strong> $${Number(payoutUsd || 0).toFixed(2)} USD</li>
        <li><strong>Daily GWC (Goodwill Commission — 2.5% 5-Level Pool):</strong> $${Number(gwcUsd || 0).toFixed(2)} USD</li>
      </ul>
      <p>Funds have been credited directly to your BotBulls wallet.</p>
    `),
  }),

  BOT_AUTO_RENEWAL: ({ fullName, feeUsd, status, expiresAt }) => ({
    subject: `BotBulls Monthly Bot ${status === 'ACTIVE' ? 'Auto-Renewed' : 'Inactive — Balance Needed'}`,
    html: wrapLayout(status === 'ACTIVE' ? 'Monthly Bot Auto-Renewed' : 'Monthly Bot Renewal Pending', status === 'ACTIVE' ? `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your monthly Bot fee of <strong>$${Number(feeUsd || 10).toFixed(2)} USD</strong> was automatically deducted from your BotBulls wallet. Your Bot is now <strong>ACTIVE</strong> through <strong>${expiresAt}</strong> (forward-only; no retroactive credits for missed days).</p>
    ` : `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your monthly Bot renewal ($${Number(feeUsd || 10).toFixed(2)} USD) could not be auto-deducted because your wallet balance is insufficient. Your Bot is currently <strong>INACTIVE</strong> and no daily payouts or GWC are accrued while inactive. Deposit funds to trigger automatic renewal immediately.</p>
    `),
  }),

  DEPOSIT_STATUS: ({ fullName, txRef, amountUsd, rail, status }) => ({
    subject: `BotBulls Deposit ${status} — ${txRef}`,
    html: wrapLayout(`Deposit ${status}`, `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your <strong>${rail}</strong> deposit request <strong>${txRef}</strong> for <strong>$${Number(amountUsd).toFixed(2)} USD</strong> is now <strong>${status}</strong>.</p>
    `),
  }),

  WITHDRAWAL_STATUS: ({ fullName, txRef, grossUsd, networkFeeUsd, netUsd, rail, status }) => ({
    subject: `BotBulls Withdrawal ${status} — ${txRef}`,
    html: wrapLayout(`Withdrawal ${status}`, `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your <strong>${rail}</strong> withdrawal request <strong>${txRef}</strong> is now <strong>${status}</strong>:</p>
      <ul>
        <li><strong>Requested Amount:</strong> $${Number(grossUsd).toFixed(2)} USD</li>
        <li><strong>BotBulls Company Deduction:</strong> $0.00 USD (0%)</li>
        <li><strong>Network / Transfer Fee (Borne by Client):</strong> $${Number(networkFeeUsd || 0).toFixed(2)} USD</li>
        <li><strong>Estimated Net Receivable:</strong> $${Number(netUsd).toFixed(2)} USD</li>
      </ul>
    `),
  }),

  FORGOT_PASSWORD: ({ fullName, otpCode, resetUrl }) => ({
    subject: 'BotBulls Password Reset Verification Code',
    html: wrapLayout('Password Reset Request', `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Use this one-time verification code to reset your BotBulls password (valid for 15 minutes):</p>
      <div style="font-size:26px;font-weight:bold;letter-spacing:6px;color:#10b981;padding:12px 16px;background:#070b14;border:1px solid #1e2c48;border-radius:10px;display:inline-block;margin:8px 0;">
        ${otpCode}
      </div>
      ${resetUrl ? `<p>Or open your reset page: <a href="${resetUrl}" style="color:#38bdf8;">${resetUrl}</a></p>` : ''}
      <p>If you did not request a password reset, you can safely ignore this email.</p>
    `),
  }),
};

async function sendAutomatedEmail({ pool, userId, to, templateType, data }) {
  const builder = TEMPLATES[templateType];
  if (!builder) throw new Error(`Unknown email template: ${templateType}`);
  const { subject, html } = builder(data || {});
  const transporter = createTransporter();

  let status = 'LOGGED_NO_SMTP';
  let errorMsg = null;

  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || `"BotBulls" <${process.env.SMTP_USER}>`,
        to,
        subject,
        html,
      });
      status = 'SENT';
    } catch (err) {
      status = 'FAILED';
      errorMsg = err.message;
    }
  }

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO email_logs (user_id, recipient_email, template_type, subject, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId || null, to, templateType, subject, status, errorMsg]
      );
    } catch {}
  }

  return { status, subject, error: errorMsg };
}

module.exports = { sendAutomatedEmail, TEMPLATES };
