/**
 * Storage Service — SQLite persistence with WAL mode, indexed queries,
 * duplicate detection, idempotency via tracking_id, DLQ integration,
 * and full audit trail. No external database required.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const config = require('../../config');
const { logger, childLogger } = require('../utils/logger');
const { Invoice, AuditEntry, DLQEntry } = require('../models/invoice.model');

class StorageService {
  constructor() {
    this.db = null;
    this._stats = { creates: 0, updates: 0, reads: 0, duplicates: 0, errors: 0 };
  }

  get isReady() { return !!this.db; }

  init() {
    if (this.db) return;

    const dbDir = path.join(config.paths.root, 'data');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const dbPath = path.join(dbDir, 'invoices.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this._migrate();
    logger.info(`SQLite storage initialized: ${dbPath}`);
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }

  // ════════════════════════════════════════
  // Schema Migration
  // ════════════════════════════════════════

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracking_id TEXT UNIQUE NOT NULL,
        invoice_uuid TEXT,
        internal_id TEXT,
        vendor TEXT,
        vendor_uid TEXT,
        vendor_iban TEXT,
        invoice_number TEXT,
        invoice_date TEXT,
        due_date TEXT,
        net_amount REAL,
        vat_amount REAL,
        vat_percent REAL,
        gross_amount REAL,
        currency TEXT DEFAULT 'EUR',
        cost_center TEXT,
        line_items TEXT DEFAULT '[]',
        confidence REAL DEFAULT 0,
        anomalies TEXT DEFAULT '[]',
        application_status TEXT DEFAULT 'Draft',
        selected_departments TEXT DEFAULT '[]',
        send_for_approval INTEGER DEFAULT 0,
        approved_by TEXT,
        approved_at TEXT,
        rejection_reason TEXT,
        source_email TEXT,
        sender TEXT,
        sender_email TEXT,
        sender_name TEXT,
        email_subject TEXT,
        email_received INTEGER DEFAULT 1,
        received_at TEXT,
        pdf_path TEXT,
        pdf_stored INTEGER DEFAULT 0,
        pdf_filename TEXT,
        pdf_size_bytes INTEGER DEFAULT 0,
        duplicate_of TEXT,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_trail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        tracking_id TEXT,
        performed_by TEXT DEFAULT 'system',
        details TEXT,
        service_version TEXT
      );

      CREATE TABLE IF NOT EXISTS dead_letter_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracking_id TEXT,
        internal_id TEXT,
        created_at TEXT,
        failed_step TEXT,
        error_message TEXT,
        error_type TEXT,
        email_subject TEXT,
        sender_email TEXT,
        retry_count INTEGER DEFAULT 0,
        last_retry_at TEXT,
        resolved INTEGER DEFAULT 0,
        resolved_at TEXT,
        raw_payload TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_invoices_tracking ON invoices(tracking_id);
      CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(application_status);
      CREATE INDEX IF NOT EXISTS idx_audit_tracking ON audit_trail(tracking_id);
      CREATE INDEX IF NOT EXISTS idx_dlq_resolved ON dead_letter_queue(resolved);
    `);
  }

  // ════════════════════════════════════════
  // Duplicate Detection
  // ════════════════════════════════════════

  async checkDuplicate(invoiceNumber, trackingId) {
    if (!invoiceNumber) return { isDuplicate: false };
    try {
      const row = this.db.prepare(
        'SELECT id FROM invoices WHERE invoice_number = ? AND tracking_id != ? LIMIT 1'
      ).get(invoiceNumber, trackingId);

      if (row) {
        this._stats.duplicates++;
        const log = childLogger(trackingId);
        log.warn(`Duplicate invoice: ${invoiceNumber} (existing id: ${row.id})`);
        return { isDuplicate: true, existingRecordId: row.id };
      }
    } catch (err) {
      logger.error(`Duplicate check failed: ${err.message}`);
    }
    return { isDuplicate: false };
  }

  /** Idempotency check via tracking_id */
  async checkIdempotent(trackingId) {
    try {
      return this.db.prepare('SELECT * FROM invoices WHERE tracking_id = ? LIMIT 1').get(trackingId) || null;
    } catch {
      return null;
    }
  }

  // ════════════════════════════════════════
  // Create Invoice Record
  // ════════════════════════════════════════

  async createInvoice(invoice, stampedPdfBuffer) {
    const log = childLogger(invoice.tracking_id);
    this.init();

    // Idempotency check
    const existing = await this.checkIdempotent(invoice.tracking_id);
    if (existing) {
      log.info(`Idempotent skip — record already exists: ${existing.id}`);
      return { recordId: existing.id, created: false };
    }

    const lineItems = JSON.stringify(invoice.line_items || []);
    const anomalies = JSON.stringify(invoice.anomalies || []);
    const departments = JSON.stringify(invoice.selected_departments || []);
    const now = new Date().toISOString();

    try {
      const result = this.db.prepare(`
        INSERT INTO invoices (
          tracking_id, invoice_uuid, internal_id, vendor, vendor_uid, vendor_iban,
          invoice_number, invoice_date, due_date,
          net_amount, vat_amount, vat_percent, gross_amount,
          currency, cost_center, line_items, confidence, anomalies,
          application_status, selected_departments, send_for_approval,
          source_email, sender, sender_email, sender_name, email_subject,
          email_received, received_at, pdf_stored, pdf_filename, pdf_size_bytes,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        invoice.tracking_id,
        invoice.invoice_uuid || null,
        invoice.internal_id,
        invoice.vendor,
        invoice.vendor_uid,
        invoice.vendor_iban,
        invoice.invoice_number,
        invoice.invoice_date,
        invoice.due_date,
        invoice.net_amount,
        invoice.vat_amount,
        invoice.vat_percent,
        invoice.gross_amount,
        invoice.currency,
        invoice.cost_center,
        lineItems,
        invoice.confidence,
        anomalies,
        invoice.application_status || 'Draft',
        departments,
        invoice.send_for_approval ? 1 : 0,
        invoice.source_email,
        invoice.sender,
        invoice.sender_email,
        invoice.sender_name,
        invoice.email_subject,
        1,
        invoice.received_at || now,
        invoice.pdf_stored ? 1 : 0,
        invoice.pdf_filename,
        invoice.pdf_size_bytes,
        now,
        now
      );

      this._stats.creates++;

      log.info(`Created invoice record: ${invoice.invoice_number} (id: ${result.lastInsertRowid})`);

      await this.writeAudit(AuditEntry.create({
        action: 'invoice_created',
        trackingId: invoice.tracking_id,
        details: { recordId: result.lastInsertRowid, vendor: invoice.vendor, gross: invoice.gross_amount, confidence: invoice.confidence },
      }));

      return { recordId: result.lastInsertRowid, created: true };
    } catch (err) {
      this._stats.errors++;
      log.error(`Failed to create invoice: ${err.message}`);
      throw err;
    }
  }

  // ════════════════════════════════════════
  // Approval Queries & Updates
  // ════════════════════════════════════════

  async findPendingApprovals() {
    this.init();
    return this.db.prepare(
      "SELECT * FROM invoices WHERE send_for_approval = 1 AND application_status = 'Draft' LIMIT 50"
    ).all();
  }

  async updateStatus(id, status, extra = {}) {
    this.init();
    const setClauses = ['application_status = ?', 'updated_at = ?'];
    const values = [status, new Date().toISOString()];

    for (const [col, val] of Object.entries(extra)) {
      setClauses.push(`${col} = ?`);
      values.push(val);
    }
    values.push(id);

    this.db.prepare(`UPDATE invoices SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    this._stats.updates++;
  }

  async findByTrackingId(trackingId) {
    this.init();
    return this.db.prepare('SELECT * FROM invoices WHERE tracking_id = ? LIMIT 1').get(trackingId) || null;
  }

  async listInvoices(limit = 100) {
    this.init();
    return this.db.prepare('SELECT * FROM invoices ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // ════════════════════════════════════════
  // Audit Trail
  // ════════════════════════════════════════

  async writeAudit(entry) {
    if (!this.db) return;
    try {
      this.db.prepare(
        'INSERT INTO audit_trail (timestamp, action, tracking_id, performed_by, details, service_version) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(entry.timestamp, entry.action, entry.tracking_id, entry.performed_by, entry.details, entry.service_version);
    } catch (err) {
      logger.error(`Audit write failed: ${err.message}`);
    }
  }

  // ════════════════════════════════════════
  // Dead Letter Queue
  // ════════════════════════════════════════

  async writeToDLQ(dlqEntry) {
    try {
      this.db.prepare(`
        INSERT INTO dead_letter_queue (
          tracking_id, internal_id, created_at, failed_step,
          error_message, error_type, email_subject, sender_email,
          retry_count, resolved, raw_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        dlqEntry.tracking_id,
        dlqEntry.internal_id,
        dlqEntry.created_at,
        dlqEntry.failed_step,
        dlqEntry.error_message,
        dlqEntry.error_type,
        dlqEntry.email_subject,
        dlqEntry.sender_email,
        dlqEntry.retry_count,
        0,
        dlqEntry.raw_payload
      );
      logger.warn(`DLQ: ${dlqEntry.failed_step} failed — ${dlqEntry.error_message.substring(0, 100)}`);
    } catch (err) {
      logger.error(`DLQ write failed: ${err.message}`);
    }
  }

  // ════════════════════════════════════════
  // Status
  // ════════════════════════════════════════

  get status() {
    let invoiceCount = 0;
    let auditCount = 0;
    let dlqCount = 0;
    if (this.db) {
      try {
        invoiceCount = this.db.prepare('SELECT COUNT(*) as c FROM invoices').get().c;
        auditCount = this.db.prepare('SELECT COUNT(*) as c FROM audit_trail').get().c;
        dlqCount = this.db.prepare('SELECT COUNT(*) as c FROM dead_letter_queue').get().c;
      } catch {}
    }
    return {
      storage: 'SQLite',
      ready: !!this.db,
      tables: { invoices: invoiceCount, audit: auditCount, dlq: dlqCount },
      stats: { ...this._stats },
    };
  }
}

module.exports = { StorageService };