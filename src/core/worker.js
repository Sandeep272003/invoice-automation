/**
 * Pipeline Worker — Orchestrates Steps 1-6 for a single invoice.
 * Each step has its own error boundary. Failures go to DLQ instead of crashing.
 */
const { logger, childLogger } = require('../utils/logger');
const { Invoice, AuditEntry, DLQEntry } = require('../models/invoice.model');
const { generateInvoiceUUID } = require('../utils/invoice-id');
const config = require('../../config');

class PipelineWorker {
  constructor({ pdfService, aiService, cleaningService, storageService }) {
    this.pdf = pdfService;
    this.ai = aiService;
    this.cleaner = cleaningService;
    this.storage = storageService;
    this._stats = { processed: 0, succeeded: 0, failed: 0, dlq: 0 };
  }

  /**
   * Run the full pipeline for one invoice.
   * @param {object} emailData — from upload endpoint or email source
   */
  async process(emailData) {
    const { trackingId } = emailData;
    const log = childLogger(trackingId);
    this._stats.processed++;

    log.info('Pipeline START');
    const startTime = Date.now();

    try {
      // ── Step 2: Extract PDF text ──
      const { text: invoiceText } = await this._runStep('pdf_extraction', trackingId, () =>
        this.pdf.extractText(emailData.pdfBuffer, emailData.pdfFilename, trackingId)
      );

      // ── Step 2b: Stamp tracking ID onto PDF ──
      const { stampedBuffer, savedPath } = await this._runStep('pdf_stamping', trackingId, () =>
        this.pdf.stampAndSave(emailData.pdfBuffer, trackingId, emailData.pdfFilename)
      );

      // ── Step 3: AI Extraction ──
      const extracted = await this._runStep('ai_extraction', trackingId, () =>
        this.ai.extract(invoiceText, trackingId)
      );

      // ── Step 4: Data Cleaning ──
      const { invoice: cleaned, warnings, errors, valid } = this._runStep('data_cleaning', trackingId, () =>
        Promise.resolve(this.cleaner.clean(extracted, emailData, trackingId))
      );

      // ── Duplicate Check ──
      if (!config.rules.processDuplicates) {
        const { isDuplicate } = await this.storage.checkDuplicate(cleaned.invoice_number, trackingId);
        if (isDuplicate) {
          log.warn('Duplicate detected — skipping');
          await this.storage.writeAudit(AuditEntry.create({
            action: 'duplicate_detected', trackingId,
            details: { invoiceNumber: cleaned.invoice_number },
          }));
          return;
        }
      }

      // ── Build Invoice Model ──
      const invoice = Invoice.create({ emailData, extractedData: cleaned, trackingId, pdfBuffer: emailData.pdfBuffer });
      invoice.pdf_stored = true;
      invoice.anomalies = cleaned.anomalies;

      // ── Generate & store UUID per invoice ──
      const invoiceUUID = extracted.invoice_uuid || generateInvoiceUUID();
      invoice.invoice_uuid = invoiceUUID;
      log.info(`Invoice UUID: ${invoiceUUID}`);

      // ── Steps 5-6: Store in SQLite ──
      const { recordId, created } = await this._runStep('storage_create', trackingId, () =>
        this.storage.createInvoice(invoice, stampedBuffer)
      );

      const elapsed = Date.now() - startTime;
      this._stats.succeeded++;

      log.info(`Pipeline SUCCESS in ${elapsed}ms`, {
        invoiceNumber: cleaned.invoice_number,
        vendor: cleaned.vendor,
        gross: cleaned.gross_amount,
        currency: cleaned.currency,
        confidence: cleaned.confidence,
        warnings: warnings.length,
        recordId,
        created,
      });

    } catch (err) {
      this._stats.failed++;
      log.error(`Pipeline FAILED: ${err.message}`, { step: err._step, stack: err.stack });

      // Send to Dead Letter Queue
      try {
        const dlq = DLQEntry.create({
          trackingId,
          step: err._step || 'unknown',
          error: err,
          emailData: { subject: emailData.subject, senderEmail: emailData.senderEmail },
          rawPayload: { pdfSize: emailData.pdfSize, filename: emailData.pdfFilename },
        });
        await this.storage.writeToDLQ(dlq);
        this._stats.dlq++;
        log.info('Sent to Dead Letter Queue');
      } catch (dlqErr) {
        log.error(`DLQ write failed: ${dlqErr.message}`);
      }
    }
  }

  /** Run a pipeline step with error wrapping */
  async _runStep(stepName, trackingId, fn) {
    try {
      const result = await fn();
      await this.storage.writeAudit(AuditEntry.create({ action: stepName, trackingId }));
      return result;
    } catch (err) {
      err._step = stepName;
      throw err;
    }
  }

  get status() {
    return {
      ...this._stats,
      successRate: this._stats.processed > 0
        ? ((this._stats.succeeded / this._stats.processed) * 100).toFixed(1) + '%'
        : 'N/A',
    };
  }
}

module.exports = { PipelineWorker };