/**
 * Express Application — API server with health checks, approval webhooks,
 * invoice upload endpoint, and production middleware.
 *
 * Only 5 env vars: GROQ_API_KEY, SMTP_MAIL, SMTP_PASSWORD, SMTP_FROM, PORT
 * Storage: SQLite (local file in data/invoices.db)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const multer = require('multer');
const config = require('../config');
const { logger } = require('./utils/logger');
const { PDFService } = require('./services/pdf.service');
const { AIService } = require('./services/ai.service');
const { CleaningService } = require('./services/cleaning.service');
const { StorageService } = require('./services/storage.service');
const { ApprovalService } = require('./services/approval.service');
const { EmailService } = require('./services/email.service');
const { PipelineWorker } = require('./core/worker');
const { generateTrackingId } = require('./utils/invoice-id');
const { validators } = require('./utils/validators');

// ════════════════════════════════════════
// Initialize Services
// ════════════════════════════════════════
const pdfService = new PDFService();
const aiService = new AIService();
const cleaningService = new CleaningService();
const storageService = new StorageService();
const approvalService = new ApprovalService(storageService);
const emailService = new EmailService();
const pipeline = new PipelineWorker({ pdfService, aiService, cleaningService, storageService });

aiService.init();
storageService.init();
approvalService.init();

// ════════════════════════════════════════
// Multer — File Upload Config
// ════════════════════════════════════════
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.rules.maxAttachmentSizeMB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || (file.originalname || '').toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

// ════════════════════════════════════════
// Express App
// ════════════════════════════════════════
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// Request logging with correlation ID
app.use((req, res, next) => {
  req.id = require('crypto').randomBytes(8).toString('hex');
  logger.debug(`${req.method} ${req.path}`, { requestId: req.id });
  next();
});

// ════════════════════════════════════════
// Health Check
// ════════════════════════════════════════
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    version: '2.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: {
      smtpMail: config.smtp.user ? config.smtp.user.split('@')[0] + '@***' : 'not set',
      groqModel: config.groq.model,
      port: config.port,
      storage: 'SQLite',
    },
    services: {
      ai: aiService.status,
      storage: storageService.status,
      approval: approvalService.status,
      pdf: pdfService.status,
      pipeline: pipeline.status,
      email: emailService.status,
    },
  });
});

app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', (_req, res) => res.json({
  status: 'ready',
  groq: !aiService.circuitBreaker.isOpen,
  storage: storageService.isReady,
}));

// ════════════════════════════════════════
// API: Upload Invoice PDF
// ════════════════════════════════════════
app.post('/api/invoices/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded. Use field name "pdf".' });

    if (!validators.isValidPDF(req.file.buffer)) {
      return res.status(400).json({ error: 'Invalid PDF file — header check failed' });
    }

    const trackingId = generateTrackingId();
    const emailData = {
      uid: `upload-${Date.now()}`,
      sender: req.body.sender || 'API Upload',
      senderEmail: req.body.senderEmail || 'upload@local',
      senderName: req.body.senderName || 'API',
      subject: req.body.subject || 'Invoice Upload',
      receivedAt: new Date().toISOString(),
      pdfBuffer: req.file.buffer,
      pdfFilename: req.file.originalname || 'invoice.pdf',
      pdfSize: req.file.size,
      trackingId,
    };

    logger.info(`Invoice upload received: ${emailData.pdfFilename} (${(emailData.pdfSize / 1024).toFixed(1)}KB) -> ${trackingId}`);

    // Process asynchronously in the pipeline
    pipeline.process(emailData).catch(err => {
      logger.error(`Upload pipeline failed for ${trackingId}: ${err.message}`);
    });

    res.json({ success: true, trackingId, message: 'Invoice queued for processing' });
  } catch (err) {
    logger.error(`Upload error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// API: List Invoices
// ════════════════════════════════════════
app.get('/api/invoices', async (_req, res) => {
  try {
    const invoices = await storageService.listInvoices();
    res.json({ success: true, data: invoices, count: invoices.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// API: Query Single Invoice
// ════════════════════════════════════════
app.get('/api/invoices/:trackingId', async (req, res) => {
  try {
    const record = await storageService.findByTrackingId(req.params.trackingId);
    if (!record) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// API: Manual Trigger Approval Cycle
// ════════════════════════════════════════
app.post('/api/approvals/run', async (_req, res) => {
  try {
    await approvalService.runApprovalCycle();
    res.json({ success: true, message: 'Approval cycle completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════
// Approval Webhook (Step 9)
// ════════════════════════════════════════
app.get('/api/invoices/:trackingId/action', async (req, res) => {
  const { trackingId } = req.params;
  const { token, reason } = req.query;

  if (!token) return res.status(400).json({ error: 'Missing token parameter' });

  const result = await approvalService.processAction(trackingId, token, reason);

  if (result.success) {
    const color = result.status === 'Fully Approved' ? '#22c55e' : '#ef4444';
    const label = result.status === 'Fully Approved' ? 'APPROVED' : 'REJECTED';
    res.send(`
      <html><body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;">
        <div style="text-align:center;padding:48px;background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <div style="width:64px;height:64px;border-radius:50%;background:${color};margin:0 auto 20px;display:flex;align-items:center;justify-content:center;">
            <span style="color:#fff;font-size:28px;">${result.status === 'Fully Approved' ? '&#10003;' : '&#10007;'}</span>
          </div>
          <h1 style="color:${color};margin:0 0 8px;font-size:24px;">Invoice ${label}</h1>
          <p style="color:#64748b;margin:0 0 4px;">Tracking ID: <strong>${trackingId}</strong></p>
          <p style="color:#94a3b8;font-size:13px;margin:0;">This page can be closed.</p>
        </div>
      </body></html>
    `);
  } else {
    res.status(400).json({ error: result.error });
  }
});

// ════════════════════════════════════════
// Global Error Handler
// ════════════════════════════════════════
app.use((err, req, res, _next) => {
  logger.error(`Unhandled error: ${err.message}`, { path: req.path, stack: err.stack });
  res.status(500).json({ error: config.nodeEnv === 'production' ? 'Internal server error' : err.message });
});

// ════════════════════════════════════════
// Start Server + Approval Cron
// ════════════════════════════════════════
const server = app.listen(config.port, () => {
  logger.info('');
  logger.info('====================================================================');
  logger.info('  Invoice Automation Enterprise  v2.0.0');
  logger.info('--------------------------------------------------------------------');
  logger.info(`  AI Engine  : Groq ${config.groq.model}`);
  logger.info('  Storage    : SQLite (data/invoices.db)');
  logger.info(`  SMTP       : ${config.smtp.host}`);
  logger.info(`  API        : http://localhost:${config.port}`);
  logger.info(`  Upload     : POST http://localhost:${config.port}/api/invoices/upload`);
  logger.info('====================================================================');
  logger.info('');

  // Start approval cron
  approvalService.startCron();
});

// Graceful shutdown
const shutdown = (signal) => {
  logger.info(`${signal} received — shutting down gracefully...`);
  server.close(() => {
    storageService.close();
    logger.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;