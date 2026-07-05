/**
 * Centralized Configuration — Minimal .env (5 vars only).
 *
 * Required .env variables:
 *   GROQ_API_KEY, SMTP_MAIL, SMTP_PASSWORD, SMTP_FROM, PORT
 *
 * SMTP host is auto-derived from email domain.
 * SQLite database path is auto-derived from project root.
 * All other settings have production-sensible defaults.
 */
const path = require('path');

function env(key, fallback, type = 'string') {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  switch (type) {
    case 'number': return Number(raw) || fallback;
    case 'boolean': return raw === 'true' || raw === '1';
    case 'json': try { return JSON.parse(raw); } catch { return fallback; }
    default: return raw;
  }
}

function required(key) {
  const v = process.env[key];
  if (!v) {
    if (process.env.NODE_ENV === 'test') return '__test_placeholder__';
    throw new Error(`Missing required env var: ${key}. Add it to your .env file.`);
  }
  return v;
}

// ── Derive SMTP host from email domain ──
function deriveSmtpHost(email) {
  const domain = (email || '').split('@')[1] || '';
  const smtpMap = {
    'gmail.com': 'smtp.gmail.com',
    'googlemail.com': 'smtp.gmail.com',
    'outlook.com': 'smtp.office365.com',
    'hotmail.com': 'smtp.office365.com',
    'live.com': 'smtp.office365.com',
    'yahoo.com': 'smtp.mail.yahoo.com',
    'icloud.com': 'smtp.mail.me.com',
  };
  return smtpMap[domain.toLowerCase()] || `smtp.${domain}`;
}

const smtpMail = required('SMTP_MAIL');
const smtpPassword = required('SMTP_PASSWORD');
const smtpFrom = required('SMTP_FROM');
const port = env('PORT', 3000, 'number');

const config = Object.freeze({
  // ── App ──
  nodeEnv: env('NODE_ENV', 'development'),
  port,
  logLevel: env('LOG_LEVEL', 'info'),
  appSecret: env('APP_SECRET', 'invoice-automation-secret-2024'),

  // ── Groq (only GROQ_API_KEY from env) ──
  groq: {
    apiKey: required('GROQ_API_KEY'),
    model: 'llama-3.3-70b-versatile',
    timeout: 45000,
    maxRetries: 3,
    retryBackoffMs: 2000,
    maxTokens: 4096,
    temperature: 0.05,
  },

  // ── SMTP (from env) ──
  smtp: {
    host: deriveSmtpHost(smtpMail),
    port: 587,
    user: smtpMail,
    pass: smtpPassword,
    from: smtpFrom,
  },

  // ── SQLite ──
  sqlite: {
    dbDir: path.resolve(__dirname, '..', 'data'),
    dbFile: 'invoices.db',
  },

  // ── Approval ──
  approval: {
    cron: '*/5 * * * *',
    baseUrl: env('APPROVAL_BASE_URL', `http://localhost:${port}/api/invoices`),
    tokenExpiryHours: 48,
    departments: {
      Finance: env('APPROVER_FINANCE', ''),
      Engineering: env('APPROVER_ENGINEERING', ''),
      Marketing: env('APPROVER_MARKETING', ''),
      Operations: env('APPROVER_OPERATIONS', ''),
      Sales: env('APPROVER_SALES', ''),
      HR: env('APPROVER_HR', ''),
    },
  },

  // ── Business Rules ──
  rules: {
    confidenceThreshold: 0.85,
    maxAttachmentSizeMB: 25,
    processDuplicates: false,
    autoRejectDaysOverdue: 90,
  },

  // ── Paths ──
  paths: {
    root: path.resolve(__dirname, '..'),
    prompts: path.resolve(__dirname, '..', 'prompts'),
    attachments: path.resolve(__dirname, '..', 'attachments'),
    logs: path.resolve(__dirname, '..', 'logs'),
    samples: path.resolve(__dirname, '..', 'sample-invoices'),
  },
});

module.exports = config;