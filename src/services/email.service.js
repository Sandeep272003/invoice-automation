/**
 * Email Service — SMTP sender for approval notifications and alerts.
 * SMTP credentials come from SMTP_MAIL / SMTP_PASSWORD env vars.
 * No IMAP dependency — invoices are received via REST API upload.
 */
const nodemailer = require('nodemailer');
const config = require('../../config');
const { logger } = require('../utils/logger');

class EmailService {
  constructor() {
    this.transporter = null;
  }

  init() {
    if (this.transporter) return;

    if (config.smtp.user && config.smtp.pass) {
      this.transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: false, // STARTTLS
        auth: { user: config.smtp.user, pass: config.smtp.pass },
      });

      this.transporter.verify()
        .then(() => logger.info(`SMTP connected: ${config.smtp.host} as ${config.smtp.user}`))
        .catch(err => logger.warn(`SMTP verification failed: ${err.message}`));
    } else {
      logger.warn('SMTP not configured — emails will be logged only (dry-run mode)');
    }
  }

  /**
   * Send an email via SMTP.
   * @param {{ to: string, subject: string, html: string }} opts
   */
  async sendMail({ to, subject, html }) {
    this.init();

    if (!this.transporter) {
      logger.info(`[DRY-RUN] Would send email to ${to}: "${subject}"`);
      return { dryRun: true, to, subject };
    }

    const result = await this.transporter.sendMail({
      from: config.smtp.from,
      to,
      subject,
      html,
    });

    logger.info(`Email sent to ${to}: "${subject}" (messageId: ${result.messageId})`);
    return { sent: true, messageId: result.messageId, to, subject };
  }

  get status() {
    return {
      smtpReady: !!this.transporter,
      smtpHost: config.smtp.host,
      smtpUser: config.smtp.user ? config.smtp.user.split('@')[0] + '@***' : 'not set',
    };
  }
}

module.exports = { EmailService };