/**
 * Validation utilities for invoice data.
 * Provides composable validators used by data-cleaner and API endpoints.
 */

const IBAN_REGEX = /^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const CURRENCIES = new Set([
  'EUR','USD','GBP','CHF','SEK','NOK','DKK','PLN','CZK','HUF','RON','BGN','HRK',
  'TRY','BRL','INR','JPY','CNY','KRW','CAD','AUD','NZD','SGD','HKD','MXN','ZAR',
  'AED','SAR','ILS','THB','MYR','IDR','PHP','VND','RUB','UAH','EGP','NGN','KES',
]);

const VENDORS_BLOCKED = new Set(['test', 'n/a', 'unknown', 'none', 'null', 'undefined']);

const validators = {
  isRequired(v, name) {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim().length === 0)) {
      throw new ValidationError(`"${name}" is required`);
    }
    return v;
  },

  isString(v) { return typeof v === 'string'; },
  isNumber(v) { return typeof v === 'number' && !isNaN(v); },
  isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); },
  isArray(v) { return Array.isArray(v); },

  isISODate(v) { return typeof v === 'string' && ISO_DATE_REGEX.test(v); },

  isIBAN(v) {
    if (!v) return false;
    const cleaned = v.replace(/\s/g, '');
    return IBAN_REGEX.test(cleaned) && cleaned.length >= 15 && cleaned.length <= 34;
  },

  isEmail(v) { return typeof v === 'string' && EMAIL_REGEX.test(v.trim()); },

  isCurrency(code) { return CURRENCIES.has(code); },

  isConfidence(v) { return typeof v === 'number' && v >= 0 && v <= 1; },

  isValidPDF(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.slice(0, 5).toString() === '%PDF-';
  },

  isVendorValid(v) {
    if (!v || typeof v !== 'string') return false;
    const lower = v.trim().toLowerCase();
    return lower.length >= 2 && !VENDORS_BLOCKED.has(lower);
  },

  isOverdue(dueDateISO, maxDays = 90) {
    const due = new Date(dueDateISO);
    const limit = new Date();
    limit.setDate(limit.getDate() - maxDays);
    return due < limit;
  },

  validateAmounts(net, vat, gross, tolerance = 0.02) {
    const issues = [];
    if (net !== null && vat !== null && gross !== null) {
      const expected = Math.round((net + vat) * 100) / 100;
      if (Math.abs(expected - gross) > tolerance) {
        issues.push(`Amount mismatch: net(${net}) + vat(${vat}) = ${expected}, gross = ${gross}`);
      }
    }
    if (net !== null && gross !== null && vat !== null && vat !== 0) {
      const vatRate = Math.round((vat / net) * 10000) / 100;
      if (vatRate < 0 || vatRate > 30) {
        issues.push(`Suspicious VAT rate: ${vatRate}%`);
      }
    }
    return issues;
  },

  validateLineItem(item) {
    const issues = [];
    if (!item || !item.description || String(item.description).trim().length === 0) {
      issues.push('Line item missing description');
      return { valid: false, issues };
    }
    if (item.quantity !== null && item.quantity !== undefined && item.quantity < 0) {
      issues.push('Negative quantity');
    }
    if (item.unit_price !== null && item.unit_price !== undefined && item.unit_price < 0) {
      issues.push('Negative unit price');
    }
    if (item.total !== null && item.total !== undefined && item.total < 0) {
      issues.push('Negative line total');
    }
    if (item.quantity > 0 && item.unit_price > 0 && item.total > 0) {
      const expected = Math.round(item.quantity * item.unit_price * 100) / 100;
      if (Math.abs(expected - item.total) > 0.02) {
        issues.push(`Line item amount mismatch: ${item.quantity} x ${item.unit_price} = ${expected}, total = ${item.total}`);
      }
    }
    return { valid: issues.length === 0, issues };
  },

  cleanNumeric(v) {
    if (v === null || v === undefined) return null;
    const n = parseFloat(v);
    if (isNaN(n)) return null;
    return Math.round(n * 100) / 100;
  },

  normalizeDate(v) {
    if (!v) return null;
    if (ISO_DATE_REGEX.test(v)) return v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  },

  normalizeCurrency(v) {
    if (!v) return 'EUR';
    const symbolMap = { '\u20ac': 'EUR', '$': 'USD', '\u00a3': 'GBP', '\u20b9': 'INR', '\u00a5': 'JPY', 'Fr': 'CHF', 'kr': 'SEK' };
    const upper = String(v).trim().toUpperCase();
    return CURRENCIES.has(upper) ? upper : (symbolMap[upper] || 'EUR');
  },
};

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field || null;
  }
}

module.exports = { validators, ValidationError };