/**
 * Data Cleaning Service — Step 4: Enterprise-grade validation pipeline.
 * Runs a series of composable validators, collects all issues, and produces
 * a clean invoice ready for storage. Never throws — always returns a result object.
 */
const { logger, childLogger } = require('../utils/logger');
const { validators, ValidationError } = require('../utils/validators');
const config = require('../../config');

class CleaningService {

  /**
   * Full cleaning pipeline.
   * @param {object} raw — AI extraction output
   * @param {object} emailData — source email metadata
   * @param {string} trackingId
   * @returns {{ invoice: object, warnings: string[], errors: string[], valid: boolean }}
   */
  clean(raw, emailData, trackingId) {
    const log = childLogger(trackingId);
    const warnings = [];
    const errors = [];

    const n = validators.cleanNumeric;
    const d = validators.normalizeDate;
    const c = validators.normalizeCurrency;

    // ── String fields ──
    const vendor = this._cleanStr(raw.vendor);
    const vendor_uid = this._cleanStr(raw.vendor_uid);
    const vendor_iban = this._cleanStr(raw.vendor_iban);
    const invoice_number = this._cleanStr(raw.invoice_number);
    const cost_center = this._cleanStr(raw.cost_center);

    if (!invoice_number) errors.push('Invoice number is missing');
    if (!validators.isVendorValid(vendor)) warnings.push(`Vendor name is suspicious: "${vendor}"`);
    if (vendor_iban && !validators.isIBAN(vendor_iban)) warnings.push('IBAN format appears invalid');

    // ── Dates ──
    const invoice_date = d(raw.invoice_date);
    const due_date = d(raw.due_date);
    if (!invoice_date) warnings.push('Invoice date could not be parsed');
    if (invoice_date && due_date && due_date < invoice_date) warnings.push(`Due date (${due_date}) is before invoice date (${invoice_date})`);
    if (due_date && validators.isOverdue(due_date, config.rules.autoRejectDaysOverdue)) warnings.push(`Due date is >${config.rules.autoRejectDaysOverdue} days overdue`);

    // ── Numbers ──
    const net_amount = n(raw.net_amount);
    const vat_amount = n(raw.vat_amount);
    const vat_percent = n(raw.vat_percent);
    const gross_amount = n(raw.gross_amount);

    // ── Cross-validate amounts ──
    const amountIssues = validators.validateAmounts(net_amount, vat_amount, gross_amount);
    warnings.push(...amountIssues);

    // ── Currency ──
    const currency = c(raw.currency);
    if (raw.currency && raw.currency !== currency) warnings.push(`Currency normalized: "${raw.currency}" -> "${currency}"`);

    // ── Line items ──
    const line_items = [];
    if (Array.isArray(raw.line_items)) {
      raw.line_items.forEach((item, idx) => {
        const v = validators.validateLineItem(item);
        if (v.valid) {
          line_items.push({
            description: String(item.description).trim(),
            quantity: n(item.quantity),
            unit_price: n(item.unit_price),
            total: n(item.total),
          });
        } else {
          warnings.push(`Line item ${idx + 1} removed: ${v.issues.join('; ')}`);
        }
      });
    }

    // ── Confidence ──
    let confidence = parseFloat(raw.confidence) || 0;
    confidence = Math.min(1, Math.max(0, confidence));
    if (confidence < config.rules.confidenceThreshold) {
      warnings.push(`Low confidence (${confidence.toFixed(2)} < ${config.rules.confidenceThreshold}) — manual review recommended`);
    }

    // ── Anomalies ──
    const anomalies = Array.isArray(raw.anomalies) ? raw.anomalies.map(String) : [];

    // ── Vendor UID format check ──
    if (vendor_uid && vendor_uid.length < 3) warnings.push('Vendor UID is very short');

    // ── VAT consistency ──
    if (net_amount > 0 && vat_amount > 0 && vat_percent > 0) {
      const impliedRate = Math.round((vat_amount / net_amount) * 10000) / 100;
      if (Math.abs(impliedRate - vat_percent) > 2) {
        warnings.push(`VAT percent (${vat_percent}%) doesn't match implied rate (${impliedRate}% from amounts)`);
      }
    }

    // ── Line items total vs gross ──
    if (line_items.length > 0 && gross_amount) {
      const itemsTotal = line_items.reduce((sum, li) => sum + (li.total || 0), 0);
      if (Math.abs(itemsTotal - gross_amount) > 1) {
        warnings.push(`Line items total (${itemsTotal.toFixed(2)}) doesn't match gross (${gross_amount})`);
      }
    }

    // ── Build result ──
    const cleaned = {
      vendor, vendor_uid, vendor_iban, invoice_number,
      invoice_date, due_date,
      net_amount, vat_amount, vat_percent, gross_amount,
      currency, cost_center,
      line_items, confidence, anomalies: [...anomalies, ...warnings],
    };

    log.info(`Cleaned: ${warnings.length} warnings, ${errors.length} errors, ${line_items.length} line items, confidence=${confidence}`);
    return { invoice: cleaned, warnings, errors, valid: errors.length === 0 };
  }

  _cleanStr(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s.length > 0 ? s : null;
  }
}

module.exports = { CleaningService };