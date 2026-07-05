/**
 * Invoice ID Generator — Creates unique, human-readable invoice tracking IDs.
 * Format: INV-YYYYMMDD-XXXX (e.g., INV-20240705-A3K7)
 * Also supports a compact internal UUID for DB records.
 */
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/O/0/1 confusion

/** Generate 4-char random suffix from ALPHABET */
function randomSuffix(len = 4) {
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * Generate a tracking ID for a new invoice.
 * @param {Date} [date=new Date()] — Date to base the ID on
 * @returns {string} e.g. "INV-20240705-A3K7"
 */
function generateTrackingId(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `INV-${y}${m}${d}-${randomSuffix(4)}`;
}

/**
 * Generate a standard UUID v4 for each invoice.
 * This is the UUID embedded/stored with the PDF.
 * @returns {string} e.g. "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 */
function generateInvoiceUUID() {
  return uuidv4();
}

/**
 * Generate a compact internal ID (32 hex chars).
 * @returns {string} e.g. "a1b2c3d4e5f6a7b8c9d0e1f2"
 */
function generateInternalId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate a signed approval token (HMAC-SHA256).
 * @param {string} trackingId
 * @param {string} action — 'approve' | 'reject'
 * @param {string} secret — APP_SECRET
 * @returns {string} Base64url token: payload.signature
 */
function generateApprovalToken(trackingId, action, secret) {
  const payload = JSON.stringify({ tid: trackingId, act: action, exp: Date.now() + 48 * 3600000 });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

/**
 * Verify an approval token.
 * @returns {{ valid: boolean, trackingId?: string, action?: string, expired?: boolean }}
 */
function verifyApprovalToken(token, secret) {
  try {
    const [payloadB64, sig] = token.split('.');
    if (!payloadB64 || !sig) return { valid: false };
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url'));
    const expectedSig = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url');
    if (sig !== expectedSig) return { valid: false };
    if (payload.exp < Date.now()) return { valid: false, expired: true };
    return { valid: true, trackingId: payload.tid, action: payload.act };
  } catch {
    return { valid: false };
  }
}

/** Parse a tracking ID into its components. */
function parseTrackingId(trackingId) {
  const match = trackingId.match(/^INV-(\d{4})(\d{2})(\d{2})-([A-Z2-9]{4})$/);
  if (!match) return null;
  return { year: match[1], month: match[2], day: match[3], suffix: match[4], date: new Date(match[1], match[2] - 1, match[3]) };
}

module.exports = { generateTrackingId, generateInvoiceUUID, generateInternalId, generateApprovalToken, verifyApprovalToken, parseTrackingId };