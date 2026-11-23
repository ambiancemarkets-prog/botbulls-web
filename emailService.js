/**
 * BotBulls (botbulls.com) — Automated Email Service (Free SMTP / Nodemailer Ready)
 * Supports Gmail App Password, Brevo, Mailtrap, or any standard SMTP via .env.
 * Templates:
 *   1. Registration Welcome Email
 *   2. Daily Payout & GWC (Goodwill Commission) Credit Email
 *   3. Deposit Status Email (Submitted / Approved / Rejected)
 *   4. Withdrawal Status Email (Requested / Approved / Rejected — with 1% deduction)
 *   5. Forgot Password / Password Reset OTP Email
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
          <span style="font-size:11px;color:#94a3b8;margin-left:8px;">botbulls.com</span>
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
    subject: 'Welcome to BotBulls (botbulls.com) — Account Activated',
    html: wrapLayout('Welcome to BotBulls!', `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your BotBulls membership account is ready:</p>
      <ul>
        <li><strong>User ID:</strong> ${userCode}</li>
        <li><strong>Referral ID:</strong> ${referralCode}</li>
      </ul>
      <p>Activate any 90-day plan ($50–$1,000) along with the monthly Bot ($25/mo for $50–$400 plans, or $50/mo for $500–$1,000 plans) to start receiving daily distributions and daily 5-level 5% GWC (Goodwill Commission).</p>
    `),
  }),

  DAILY_PAYOUT_GWC: ({ fullName, payoutUsd, gwcUsd, ratePercent, dateStr }) => ({
    subject: `BotBulls Daily Credit (${dateStr}) — Payout & GWC Summary`,
    html: wrapLayout('Daily Payout & GWC Credit', `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your active BotBulls account has received today's distribution (${dateStr}):</p>
      <ul>
        <li><strong>Daily Distribution (${ratePercent}%):</strong> $${Number(payoutUsd || 0).toFixed(2)} USD</li>
        <li><strong>Daily GWC (Goodwill Commission):</strong> $${Number(gwcUsd || 0).toFixed(2)} USD</li>
      </ul>
      <p>Funds have been credited directly to your BotBulls wallet.</p>
    `),
  }),

  DEPOSIT_STATUS: ({ fullName, txRef, amountUsd, rail, status }) => ({
    subject: `BotBulls Deposit ${status} — ${txRef}`,
    html: wrapLayout(`Deposit ${status}`, `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your <strong>${rail}</strong> deposit request <strong>${txRef}</strong> for <strong>$${Number(amountUsd).toFixed(2)} USD</strong> is now <strong>${status}</strong>.</p>
    `),
  }),

  WITHDRAWAL_STATUS: ({ fullName, txRef, grossUsd, deductionUsd, netUsd, rail, status }) => ({
    subject: `BotBulls Withdrawal ${status} — ${txRef}`,
    html: wrapLayout(`Withdrawal ${status}`, `
      <p>Hi <strong>${fullName}</strong>,</p>
      <p>Your <strong>${rail}</strong> withdrawal request <strong>${txRef}</strong> is now <strong>${status}</strong>:</p>
      <ul>
        <li><strong>Requested Amount:</strong> $${Number(grossUsd).toFixed(2)} USD</li>
        <li><strong>Withdrawal Deduction (1%):</strong> -$${Number(deductionUsd).toFixed(2)} USD</li>
        <li><strong>Net Receivable Payout:</strong> $${Number(netUsd).toFixed(2)} USD</li>
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
