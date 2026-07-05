/**
 * Approval Service — Production approval engine with signed tokens,
 * department-based routing, and SMTP email notifications.
 *
 * Storage: SQLite rows (no .fields wrapper).
 * SMTP credentials derived from SMTP_MAIL / SMTP_PASSWORD env vars.
 */
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const config = require('../../config');
const { logger, childLogger } = require('../utils/logger');
const { generateApprovalToken, verifyApprovalToken } = require('../utils/invoice-id');
const { AuditEntry } = require('../models/invoice.model');

class ApprovalService {
  constructor(storageService) {
    this.storage = storageService;
    this.transporter = null;
    this._cronRunning = false;
    this._stats = { sent: 0, approved: 0, rejected: 0, errors: 0 };
  }

  init() {
    if (this.transporter) return;

    if (config.smtp.user && config.smtp.pass) {
      this.transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: false,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
      });

      this.transporter.verify()
        .then(() => logger.info(`SMTP connected: ${config.smtp.host} as ${config.smtp.user}`))
        .catch(err => logger.warn(`SMTP verification failed: ${err.message}`));
    } else {
      logger.warn('SMTP not configured — approval emails will be logged only');
    }
  }

  startCron() {
    if (this._cronRunning) return;
    this._cronRunning = true;
    cron.schedule(config.approval.cron, () => this.runApprovalCycle());
    logger.info(`Approval cron started: ${config.approval.cron}`);
    this.runApprovalCycle().catch(err => logger.error('Initial approval cycle error:', err.message));
  }

  // ════════════════════════════════════════
  // Step 8: Find & Route Pending Approvals
  // ════════════════════════════════════════

  async runApprovalCycle() {
    logger.info('Running approval cycle...');
    try {
      const invoices = await this.storage.findPendingApprovals();
      if (!invoices.length) { logger.debug('No pending approvals'); return; }

      logger.info(`Found ${invoices.length} invoice(s) pending approval`);

      for (const row of invoices) {
        const trackingId = row.tracking_id;
        const departments = this._parseJSON(row.selected_departments, []);

        const approvers = [...new Set(
          departments.map(dept => config.approval.departments[dept]).filter(Boolean)
        )];

        if (!approvers.length) {
          logger.warn(`No approvers configured for departments [${departments.join(',')}], invoice: ${trackingId}`);
          continue;
        }

        for (const approverEmail of approvers) {
          await this._sendApprovalEmail(trackingId, row, approverEmail);
        }

        await this.storage.writeAudit(AuditEntry.create({
          action: 'approval_sent', trackingId,
          details: { approvers, departments, invoiceNumber: row.invoice_number },
        }));
      }
    } catch (err) {
      logger.error(`Approval cycle error: ${err.message}`);
      this._stats.errors++;
    }
  }

  async _sendApprovalEmail(trackingId, row, approverEmail) {
    const invNum = row.invoice_number || trackingId;
    const vendor = row.vendor || 'N/A';
    const gross = row.gross_amount || 'N/A';
    const currency = row.currency || 'EUR';

    const approveToken = generateApprovalToken(trackingId, 'approve', config.appSecret);
    const rejectToken = generateApprovalToken(trackingId, 'reject', config.appSecret);
    const approveUrl = `${config.approval.baseUrl}/${trackingId}/action?token=${approveToken}`;
    const rejectUrl = `${config.approval.baseUrl}/${trackingId}/action?token=${rejectToken}`;

    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#1a1a2e;color:#fff;padding:20px 30px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;font-size:18px;">Invoice Approval Required</h2>
        </div>
        <div style="border:1px solid #e2e8f0;padding:24px;border-radius:0 0 8px 8px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:8px 0;color:#64748b;">Tracking ID</td><td style="padding:8px 0;font-weight:600;">${trackingId}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;">Invoice</td><td style="padding:8px 0;font-weight:600;">${invNum}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;">Vendor</td><td style="padding:8px 0;">${vendor}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;">Amount</td><td style="padding:8px 0;font-weight:600;font-size:18px;">${gross} ${currency}</td></tr>
          </table>
          <div style="margin-top:24px;display:flex;gap:12px;">
            <a href="${approveUrl}" style="flex:1;display:block;text-align:center;padding:14px;background:#22c55e;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Approve</a>
            <a href="${rejectUrl}" style="flex:1;display:block;text-align:center;padding:14px;background:#ef4444;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Reject</a>
          </div>
          <p style="margin-top:20px;font-size:12px;color:#94a3b8;">This link expires in ${config.approval.tokenExpiryHours}h. Do not forward.</p>
        </div>
      </div>`;

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: config.smtp.from,
          to: approverEmail,
          subject: `[Approval] ${invNum} — ${vendor} — ${gross} ${currency}`,
          html,
        });
        this._stats.sent++;
        logger.info(`Approval email sent to ${approverEmail} for ${trackingId}`);
      } catch (err) {
        logger.error(`Failed to send approval email to ${approverEmail}: ${err.message}`);
        this._stats.errors++;
      }
    } else {
      logger.info(`[DRY-RUN] Would send approval to ${approverEmail} for ${trackingId}`);
      logger.info(`  Approve: ${approveUrl}`);
      logger.info(`  Reject:  ${rejectUrl}`);
    }
  }

  // ════════════════════════════════════════
  // Step 9: Process Approval / Rejection
  // ════════════════════════════════════════

  async processAction(trackingId, token, reason = '') {
    const log = childLogger(trackingId);

    const verification = verifyApprovalToken(token, config.appSecret);
    if (!verification.valid) {
      if (verification.expired) return { success: false, error: 'Token expired' };
      return { success: false, error: 'Invalid token' };
    }
    if (verification.trackingId !== trackingId) {
      return { success: false, error: 'Token mismatch' };
    }

    const action = verification.action;

    // SQLite row — no .fields wrapper
    const record = await this.storage.findByTrackingId(trackingId);
    if (!record) return { success: false, error: 'Invoice not found' };
    if (record.application_status !== 'Draft') {
      return { success: false, error: `Invoice already ${record.application_status}` };
    }

    const now = new Date().toISOString();

    if (action === 'approve') {
      await this.storage.updateStatus(record.id, 'Fully Approved', {
        approved_at: now,
        approved_by: 'email-approval',
      });
      this._stats.approved++;
      await this.storage.writeAudit(AuditEntry.create({
        action: 'approved', trackingId, performedBy: 'email-approval',
        details: { recordId: record.id, invoiceNumber: record.invoice_number },
      }));
      log.info('APPROVED by email');
      return { success: true, status: 'Fully Approved' };
    }

    if (action === 'reject') {
      await this.storage.updateStatus(record.id, 'Rejected', {
        rejection_reason: reason || 'Rejected via approval link',
      });
      this._stats.rejected++;
      await this.storage.writeAudit(AuditEntry.create({
        action: 'rejected', trackingId, performedBy: 'email-approval',
        details: { recordId: record.id, invoiceNumber: record.invoice_number, reason },
      }));
      log.info(`REJECTED by email: ${reason}`);
      return { success: true, status: 'Rejected' };
    }

    return { success: false, error: 'Unknown action' };
  }

  /** Safely parse JSON stored in SQLite TEXT columns */
  _parseJSON(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
  }

  get status() {
    return {
      cronRunning: this._cronRunning,
      smtpReady: !!this.transporter,
      smtpHost: config.smtp.host,
      smtpUser: config.smtp.user ? config.smtp.user.split('@')[0] + '@***' : 'not set',
      stats: { ...this._stats },
    };
  }
}

module.exports = { ApprovalService };