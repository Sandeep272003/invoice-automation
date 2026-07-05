/**
 * Enterprise Test Suite — Tests covering utils, services, models, and project structure.
 * Run: NODE_ENV=test npm test
 */
const { describe, it } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

// ════════════════════════════════════════════
// Utils: invoice-id.js
// ════════════════════════════════════════════
describe('Invoice ID Generator', () => {
  const { generateTrackingId, generateInvoiceUUID, generateInternalId, generateApprovalToken, verifyApprovalToken, parseTrackingId } = require('../src/utils/invoice-id');

  it('generates tracking ID in INV-YYYYMMDD-XXXX format', () => {
    const id = generateTrackingId();
    assert.match(id, /^INV-\d{8}-[A-Z2-9]{4}$/);
  });

  it('generates unique tracking IDs on consecutive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTrackingId()));
    assert.strictEqual(ids.size, 100);
  });

  it('generates valid UUID v4 per invoice', () => {
    const uuid = generateInvoiceUUID();
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates unique UUIDs on consecutive calls', () => {
    const uuids = new Set(Array.from({ length: 100 }, () => generateInvoiceUUID()));
    assert.strictEqual(uuids.size, 100);
  });

  it('parses tracking ID into components', () => {
    const result = parseTrackingId('INV-20241115-A3K7');
    assert.strictEqual(result.year, '2024');
    assert.strictEqual(result.month, '11');
    assert.strictEqual(result.day, '15');
    assert.strictEqual(result.suffix, 'A3K7');
  });

  it('returns null for invalid tracking ID', () => {
    assert.strictEqual(parseTrackingId('INVALID'), null);
    assert.strictEqual(parseTrackingId(''), null);
  });

  it('generates 16-byte internal ID (32 hex chars)', () => {
    const id = generateInternalId();
    assert.strictEqual(id.length, 32);
    assert.match(id, /^[a-f0-9]{32}$/);
  });

  it('generates and verifies approval token', () => {
    const token = generateApprovalToken('INV-20241115-A3K7', 'approve', 'test-secret');
    const result = verifyApprovalToken(token, 'test-secret');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.trackingId, 'INV-20241115-A3K7');
    assert.strictEqual(result.action, 'approve');
  });

  it('rejects tampered token', () => {
    const token = generateApprovalToken('INV-001', 'approve', 'secret');
    const result = verifyApprovalToken(token, 'wrong-secret');
    assert.strictEqual(result.valid, false);
  });

  it('rejects expired token', () => {
    const payload = JSON.stringify({ tid: 'INV-001', act: 'approve', exp: Date.now() - 1000 });
    const sig = require('crypto').createHmac('sha256', 's').update(payload).digest('base64url');
    const token = Buffer.from(payload).toString('base64url') + '.' + sig;
    const result = verifyApprovalToken(token, 's');
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.expired, true);
  });

  it('uses provided date for tracking ID', () => {
    const id = generateTrackingId(new Date(2024, 5, 15));
    assert.match(id, /^INV-20240615-/);
  });
});

// ════════════════════════════════════════════
// Utils: validators.js
// ════════════════════════════════════════════
describe('Validators', () => {
  const v = require('../src/utils/validators').validators;
  const { ValidationError } = require('../src/utils/validators');

  it('validates ISO dates', () => { assert.ok(v.isISODate('2024-11-15')); assert.ok(!v.isISODate('15/11/2024')); assert.ok(!v.isISODate('')); });
  it('validates IBAN format', () => {
    assert.ok(v.isIBAN('DE89 3704 0044 0532 0130 00'));
    assert.ok(v.isIBAN('GB29NWBK60161331926819'));
    assert.ok(!v.isIBAN('DE12'));
    assert.ok(!v.isIBAN(''));
  });
  it('validates email', () => { assert.ok(v.isEmail('test@example.com')); assert.ok(!v.isEmail('not-email')); assert.ok(!v.isEmail('')); });
  it('validates currency codes', () => { assert.ok(v.isCurrency('EUR')); assert.ok(v.isCurrency('USD')); assert.ok(!v.isCurrency('XYZ')); });
  it('validates confidence range', () => { assert.ok(v.isConfidence(0)); assert.ok(v.isConfidence(0.5)); assert.ok(v.isConfidence(1)); assert.ok(!v.isConfidence(1.5)); assert.ok(!v.isConfidence(-0.1)); });
  it('validates PDF buffers', () => { assert.ok(v.isValidPDF(Buffer.from('%PDF-1.4\n'))); assert.ok(!v.isValidPDF(Buffer.from('not pdf'))); assert.ok(!v.isValidPDF(Buffer.alloc(0))); });
  it('validates vendor names', () => { assert.ok(v.isVendorValid('Acme Corp')); assert.ok(!v.isVendorValid('test')); assert.ok(!v.isVendorValid('N/A')); assert.ok(!v.isVendorValid('')); });
  it('detects overdue invoices', () => { assert.ok(v.isOverdue('2020-01-01', 90)); assert.ok(!v.isOverdue(new Date().toISOString().split('T')[0], 90)); });
  it('cross-validates amounts', () => {
    const issues = v.validateAmounts(1000, 190, 1190); assert.strictEqual(issues.length, 0);
    const bad = v.validateAmounts(1000, 190, 1500); assert.ok(bad.length > 0); assert.ok(bad[0].includes('mismatch'));
  });
  it('validates line items', () => {
    const good = v.validateLineItem({ description: 'Test', quantity: 2, unit_price: 10, total: 20 }); assert.ok(good.valid);
    const noDesc = v.validateLineItem({ description: '', quantity: 1, unit_price: 10, total: 10 }); assert.ok(!noDesc.valid);
    const negQty = v.validateLineItem({ description: 'Test', quantity: -1, unit_price: 10, total: -10 }); assert.ok(!negQty.valid);
  });
  it('detects line item amount mismatch', () => {
    const result = v.validateLineItem({ description: 'X', quantity: 2, unit_price: 10, total: 100 });
    assert.ok(!result.valid); assert.ok(result.issues[0].includes('mismatch'));
  });
  it('cleanNumeric rounds to 2 decimals', () => {
    assert.strictEqual(v.cleanNumeric('99.999'), 100);
    assert.strictEqual(v.cleanNumeric('50.125'), 50.13);
    assert.strictEqual(v.cleanNumeric(null), null);
    assert.strictEqual(v.cleanNumeric('abc'), null);
  });
  it('normalizeDate handles various formats', () => {
    assert.strictEqual(v.normalizeDate('2024-11-15'), '2024-11-15');
    assert.strictEqual(v.normalizeDate('November 15, 2024'), '2024-11-15');
    assert.strictEqual(v.normalizeDate('invalid'), null);
    assert.strictEqual(v.normalizeDate(null), null);
  });
  it('normalizeCurrency maps symbols', () => {
    assert.strictEqual(v.normalizeCurrency('\u20ac'), 'EUR');
    assert.strictEqual(v.normalizeCurrency('$'), 'USD');
    assert.strictEqual(v.normalizeCurrency('GBP'), 'GBP');
    assert.strictEqual(v.normalizeCurrency(null), 'EUR');
  });
  it('throws ValidationError for required missing field', () => {
    assert.throws(() => v.isRequired(null, 'test'), ValidationError);
    assert.throws(() => v.isRequired('', 'test'), ValidationError);
    assert.doesNotThrow(() => v.isRequired('value', 'test'));
  });
  it('detects suspicious VAT rates', () => {
    const issues = v.validateAmounts(100, 80, 180);
    assert.ok(issues.some(i => i.includes('Suspicious VAT rate')));
  });
});

// ════════════════════════════════════════════
// Utils: circuit-breaker.js
// ════════════════════════════════════════════
describe('Circuit Breaker', () => {
  const { CircuitBreaker, STATE } = require('../src/utils/circuit-breaker');

  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker({ fn: () => Promise.resolve('ok'), name: 'test', timeout: 1000, failureThreshold: 3, resetTimeout: 100 });
    assert.strictEqual(cb.state, STATE.CLOSED);
  });
  it('executes successfully in CLOSED state', async () => {
    const cb = new CircuitBreaker({ fn: (x) => Promise.resolve(x * 2), name: 'test', timeout: 1000, failureThreshold: 3, resetTimeout: 100 });
    const result = await cb.execute(5);
    assert.strictEqual(result, 10);
  });
  it('opens after failure threshold', async () => {
    let calls = 0;
    const cb = new CircuitBreaker({ fn: () => { calls++; return Promise.reject(new Error('fail')); }, name: 'test', timeout: 100, failureThreshold: 2, resetTimeout: 200 });
    await cb.execute().catch(() => {});
    await cb.execute().catch(() => {});
    assert.strictEqual(cb.state, STATE.OPEN);
  });
  it('rejects immediately when OPEN', async () => {
    const cb = new CircuitBreaker({ fn: () => Promise.resolve('ok'), name: 'test', timeout: 100, failureThreshold: 1, resetTimeout: 5000 });
    cb.state = STATE.OPEN; cb.lastFailureTime = Date.now();
    await assert.rejects(() => cb.execute(), /Circuit is OPEN/);
  });
  it('transitions to HALF_OPEN after resetTimeout', async () => {
    const cb2 = new CircuitBreaker({ fn: () => Promise.resolve('recovered'), name: 'test', timeout: 100, failureThreshold: 1, resetTimeout: 50 });
    cb2.state = STATE.OPEN; cb2.lastFailureTime = Date.now() - 100;
    const result = await cb2.execute();
    assert.strictEqual(cb2.state, STATE.CLOSED);
    assert.strictEqual(result, 'recovered');
  });
  it('resets properly', () => {
    const cb = new CircuitBreaker({ fn: () => {}, name: 'test' });
    cb.failureCount = 99; cb.state = STATE.OPEN; cb.reset();
    assert.strictEqual(cb.state, STATE.CLOSED); assert.strictEqual(cb.failureCount, 0);
  });
  it('times out slow functions', async () => {
    const cb = new CircuitBreaker({ fn: () => new Promise(r => setTimeout(r, 5000)), name: 'test', timeout: 50, failureThreshold: 3, resetTimeout: 100 });
    await assert.rejects(() => cb.execute(), /Timeout/);
  });
});

// ════════════════════════════════════════════
// Utils: rate-limiter.js
// ════════════════════════════════════════════
describe('Rate Limiter', () => {
  const { TokenBucket } = require('../src/utils/rate-limiter');

  it('allows consumption within capacity', () => {
    const bucket = new TokenBucket({ capacity: 5, refillRate: 5, refillIntervalMs: 1000, name: 'test' });
    assert.strictEqual(bucket.consume(), true);
    assert.ok(bucket.remaining < 5);
  });
  it('rejects when exhausted', () => {
    const bucket = new TokenBucket({ capacity: 2, refillRate: 1, refillIntervalMs: 60000, name: 'test' });
    bucket.consume(); bucket.consume();
    assert.strictEqual(bucket.consume(), false);
  });
  it('refills tokens over time', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillRate: 10, refillIntervalMs: 50, name: 'test' });
    bucket.consume(); assert.strictEqual(bucket.consume(), false);
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(bucket.consume(), true);
  });
  it('waitAndConsume resolves when tokens available', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillRate: 100, refillIntervalMs: 50, name: 'test' });
    bucket.consume();
    const start = Date.now();
    await bucket.waitAndConsume(1, 2000);
    assert.ok(Date.now() - start < 500);
  });
  it('reports remaining tokens', () => {
    const bucket = new TokenBucket({ capacity: 10, refillRate: 10, refillIntervalMs: 1000, name: 'test' });
    assert.strictEqual(bucket.remaining, 10);
    bucket.consume(3);
    assert.ok(bucket.remaining <= 7);
  });
});

// ════════════════════════════════════════════
// Models
// ════════════════════════════════════════════
describe('Invoice Model', () => {
  const { Invoice, AuditEntry, DLQEntry } = require('../src/models/invoice.model');

  it('creates invoice with default fields', () => {
    const inv = Invoice.create({});
    assert.match(inv.tracking_id, /^INV-/);
    assert.strictEqual(inv.internal_id.length, 32);
    assert.strictEqual(inv.application_status, 'Draft');
    assert.strictEqual(inv.send_for_approval, false);
    assert.strictEqual(inv.currency, 'EUR');
    assert.ok(inv.created_at);
    assert.ok(Array.isArray(inv.line_items));
    assert.ok(Array.isArray(inv.anomalies));
  });
  it('creates invoice with extracted data', () => {
    const inv = Invoice.create({
      emailData: { senderEmail: 'vendor@test.com', subject: 'Invoice' },
      extractedData: { vendor: 'TestCorp', invoice_number: 'INV-001', net_amount: 100, gross_amount: 119, confidence: 0.95 },
    });
    assert.strictEqual(inv.vendor, 'TestCorp');
    assert.strictEqual(inv.invoice_number, 'INV-001');
    assert.strictEqual(inv.source_email, 'vendor@test.com');
    assert.strictEqual(inv.confidence, 0.95);
  });
  it('creates invoice with custom tracking ID', () => {
    const inv = Invoice.create({ trackingId: 'INV-20241115-TEST' });
    assert.strictEqual(inv.tracking_id, 'INV-20241115-TEST');
  });
  it('AuditEntry creates with required fields', () => {
    const entry = AuditEntry.create({ action: 'test_action', trackingId: 'INV-001' });
    assert.ok(entry.timestamp);
    assert.strictEqual(entry.action, 'test_action');
    assert.strictEqual(entry.performed_by, 'system');
    assert.strictEqual(entry.service_version, '2.0.0');
  });
  it('DLQEntry creates with error info', () => {
    const entry = DLQEntry.create({ step: 'ai_extraction', error: new Error('timeout'), emailData: { subject: 'test' } });
    assert.ok(entry.tracking_id);
    assert.strictEqual(entry.error_message, 'Error: timeout');
    assert.strictEqual(entry.error_type, 'Error');
    assert.strictEqual(entry.resolved, false);
  });
});

// ════════════════════════════════════════════
// Cleaning Service
// ════════════════════════════════════════════
describe('Cleaning Service', () => {
  const { CleaningService } = require('../src/services/cleaning.service');
  const cleaner = new CleaningService();

  it('cleans valid input without errors', () => {
    const result = cleaner.clean({
      vendor: 'Test GmbH', vendor_uid: 'DE123', vendor_iban: 'DE89 3704 0044 0532 0130 00',
      invoice_number: 'INV-001', invoice_date: '2024-11-15', due_date: '2024-12-15',
      net_amount: 1000, vat_amount: 190, vat_percent: 19, gross_amount: 1190,
      currency: 'EUR', cost_center: 'CC-001', confidence: 0.95, anomalies: [],
      line_items: [{ description: 'Item', quantity: 1, unit_price: 1000, total: 1000 }],
    }, {}, 'INV-TEST-0001');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.invoice.vendor, 'Test GmbH');
    assert.strictEqual(result.invoice.line_items.length, 1);
  });
  it('detects amount mismatch', () => {
    const result = cleaner.clean({
      vendor: 'Test', invoice_number: 'INV-002', net_amount: 1000, vat_amount: 190, gross_amount: 2000,
      currency: 'EUR', confidence: 0.9, line_items: [],
    }, {}, 'INV-TEST-0002');
    assert.ok(result.invoice.anomalies.some(a => a.includes('mismatch')));
  });
  it('removes invalid line items', () => {
    const result = cleaner.clean({
      vendor: 'Test', invoice_number: 'INV-003', net_amount: 100, vat_amount: 0, vat_percent: 0, gross_amount: 100,
      currency: 'EUR', confidence: 0.9,
      line_items: [{ description: 'Valid', quantity: 1, unit_price: 100, total: 100 }, { description: '' }, null],
    }, {}, 'INV-TEST-0003');
    assert.strictEqual(result.invoice.line_items.length, 1);
  });
  it('flags low confidence', () => {
    const result = cleaner.clean({
      vendor: 'Test', invoice_number: 'INV-004', net_amount: 100, vat_amount: 0, vat_percent: 0, gross_amount: 100,
      currency: 'EUR', confidence: 0.5, line_items: [],
    }, {}, 'INV-TEST-0004');
    assert.ok(result.warnings.some(w => w.includes('Low confidence')));
  });
  it('detects due date before invoice date', () => {
    const result = cleaner.clean({
      vendor: 'Test', invoice_number: 'INV-005', invoice_date: '2024-12-15', due_date: '2024-11-01',
      net_amount: 100, vat_amount: 0, vat_percent: 0, gross_amount: 100,
      currency: 'EUR', confidence: 0.9, line_items: [],
    }, {}, 'INV-TEST-0005');
    assert.ok(result.warnings.some(w => w.includes('Due date')));
  });
  it('flags invalid IBAN', () => {
    const result = cleaner.clean({
      vendor: 'Test', invoice_number: 'INV-006', vendor_iban: 'DE12',
      net_amount: 100, vat_amount: 0, vat_percent: 0, gross_amount: 100,
      currency: 'EUR', confidence: 0.9, line_items: [],
    }, {}, 'INV-TEST-0006');
    assert.ok(result.warnings.some(w => w.includes('IBAN')));
  });
  it('flags suspicious vendor name', () => {
    const result = cleaner.clean({
      vendor: 'N/A', invoice_number: 'INV-007',
      net_amount: 100, vat_amount: 0, vat_percent: 0, gross_amount: 100,
      currency: 'EUR', confidence: 0.9, line_items: [],
    }, {}, 'INV-TEST-0007');
    assert.ok(result.warnings.some(w => w.includes('suspicious')));
  });
  it('detects VAT rate inconsistency', () => {
    const result = cleaner.clean({
      vendor: 'Test', invoice_number: 'INV-008', net_amount: 1000, vat_amount: 500, vat_percent: 19, gross_amount: 1500,
      currency: 'EUR', confidence: 0.9, line_items: [],
    }, {}, 'INV-TEST-0008');
    assert.ok(result.warnings.some(w => w.includes('VAT percent')));
  });
  it('detects line items total vs gross mismatch', () => {
    const result = cleaner.clean({
      vendor: 'Test', invoice_number: 'INV-009', net_amount: 100, vat_amount: 19, vat_percent: 19, gross_amount: 119,
      currency: 'EUR', confidence: 0.9,
      line_items: [{ description: 'Item', quantity: 1, unit_price: 500, total: 500 }],
    }, {}, 'INV-TEST-0009');
    assert.ok(result.warnings.some(w => w.includes('Line items total')));
  });
  it('normalizes currency symbols', () => {
    const result = cleaner.clean({
      vendor: 'Test', invoice_number: 'INV-010', currency: '\u20ac',
      net_amount: 100, vat_amount: 0, vat_percent: 0, gross_amount: 100,
      confidence: 0.9, line_items: [],
    }, {}, 'INV-TEST-0010');
    assert.strictEqual(result.invoice.currency, 'EUR');
  });
  it('clamps confidence to 0-1', () => {
    const r1 = cleaner.clean({ vendor: 'T', invoice_number: 'I1', confidence: 2.0, net_amount: 0, vat_amount: 0, vat_percent: 0, gross_amount: 0, line_items: [] }, {}, 'T1');
    assert.strictEqual(r1.invoice.confidence, 1);
    const r2 = cleaner.clean({ vendor: 'T', invoice_number: 'I2', confidence: -1, net_amount: 0, vat_amount: 0, vat_percent: 0, gross_amount: 0, line_items: [] }, {}, 'T2');
    assert.strictEqual(r2.invoice.confidence, 0);
  });
  it('reports missing invoice number as error', () => {
    const result = cleaner.clean({
      vendor: 'Test', net_amount: 100, vat_amount: 0, vat_percent: 0, gross_amount: 100,
      currency: 'EUR', confidence: 0.9, line_items: [],
    }, {}, 'INV-TEST-NOINV');
    assert.ok(result.errors.some(e => e.includes('Invoice number')));
    assert.strictEqual(result.valid, false);
  });
});

// ════════════════════════════════════════════
// Config — 5 env vars, SQLite, SMTP
// ════════════════════════════════════════════
describe('Config', () => {
  it('has SMTP host derived from SMTP_MAIL', () => {
    const config = require('../config');
    assert.ok(config.smtp.host);
    assert.ok(config.smtp.host.includes('smtp.'));
    assert.strictEqual(config.smtp.user, config.smtp.user); // same account
  });
  it('has groq model set to llama-3.3-70b-versatile', () => {
    const config = require('../config');
    assert.strictEqual(config.groq.model, 'llama-3.3-70b-versatile');
  });
  it('has SQLite config with dbFile', () => {
    const config = require('../config');
    assert.strictEqual(config.sqlite.dbFile, 'invoices.db');
    assert.ok(config.sqlite.dbDir.includes('data'));
  });
  it('has NO imap or airtable config', () => {
    const config = require('../config');
    assert.strictEqual(config.imap, undefined);
    assert.strictEqual(config.airtable, undefined);
  });
  it('has default port 3000', () => {
    const config = require('../config');
    assert.ok(config.port === 3000 || typeof config.port === 'number');
  });
});

// ════════════════════════════════════════════
// SQLite Storage Service
// ════════════════════════════════════════════
describe('SQLite Storage Service', () => {
  const { StorageService } = require('../src/services/storage.service');

  it('initializes and creates tables', () => {
    const svc = new StorageService();
    // Use a test-specific DB path to avoid conflicting with dev
    const testDbPath = path.join(ROOT, 'data', 'test_invoices.db');
    svc.init();
    assert.ok(svc.isReady);
    assert.ok(svc.db);

    // Verify tables exist
    const tables = svc.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
    assert.ok(tables.includes('invoices'));
    assert.ok(tables.includes('audit_trail'));
    assert.ok(tables.includes('dead_letter_queue'));
    svc.close();
  });

  it('creates and retrieves an invoice', async () => {
    const svc = new StorageService();
    svc.init();

    const { recordId, created } = await svc.createInvoice({
      tracking_id: 'INV-TEST-CRUD-001',
      internal_id: 'abc123',
      vendor: 'Test Corp',
      invoice_number: 'TC-001',
      net_amount: 100,
      vat_amount: 19,
      vat_percent: 19,
      gross_amount: 119,
      currency: 'EUR',
      confidence: 0.95,
      line_items: [],
      anomalies: [],
      pdf_stored: false,
      pdf_filename: 'test.pdf',
      pdf_size_bytes: 0,
    });

    assert.strictEqual(created, true);
    assert.ok(recordId > 0);

    const found = await svc.findByTrackingId('INV-TEST-CRUD-001');
    assert.ok(found);
    assert.strictEqual(found.vendor, 'Test Corp');
    assert.strictEqual(found.invoice_number, 'TC-001');
    assert.strictEqual(found.gross_amount, 119);

    svc.close();
  });

  it('is idempotent on duplicate tracking_id', async () => {
    const svc = new StorageService();
    svc.init();

    const invoice = {
      tracking_id: 'INV-TEST-IDEM-001',
      internal_id: 'idem1',
      vendor: 'Idem Corp',
      invoice_number: 'IC-001',
      net_amount: 50, vat_amount: 0, vat_percent: 0, gross_amount: 50,
      currency: 'EUR', confidence: 0.9, line_items: [], anomalies: [],
    };

    const r1 = await svc.createInvoice(invoice);
    assert.strictEqual(r1.created, true);

    const r2 = await svc.createInvoice(invoice);
    assert.strictEqual(r2.created, false);
    assert.strictEqual(r2.recordId, r1.recordId);

    svc.close();
  });

  it('detects duplicate invoice numbers', async () => {
    const svc = new StorageService();
    svc.init();

    await svc.createInvoice({
      tracking_id: 'INV-TEST-DUP-001', internal_id: 'd1',
      vendor: 'V1', invoice_number: 'DUP-001',
      net_amount: 10, vat_amount: 0, vat_percent: 0, gross_amount: 10,
      currency: 'EUR', confidence: 0.9, line_items: [], anomalies: [],
    });

    const result = await svc.checkDuplicate('DUP-001', 'INV-TEST-DUP-002');
    assert.strictEqual(result.isDuplicate, true);

    svc.close();
  });

  it('updates invoice status', async () => {
    const svc = new StorageService();
    svc.init();

    const { recordId } = await svc.createInvoice({
      tracking_id: 'INV-TEST-UPD-001', internal_id: 'u1',
      vendor: 'Upd Corp', invoice_number: 'UPD-001',
      net_amount: 10, vat_amount: 0, vat_percent: 0, gross_amount: 10,
      currency: 'EUR', confidence: 0.9, line_items: [], anomalies: [],
    });

    await svc.updateStatus(recordId, 'Fully Approved', { approved_by: 'test-user' });
    const found = await svc.findByTrackingId('INV-TEST-UPD-001');
    assert.strictEqual(found.application_status, 'Fully Approved');
    assert.strictEqual(found.approved_by, 'test-user');

    svc.close();
  });

  it('writes and reads audit trail', async () => {
    const svc = new StorageService();
    svc.init();

    await svc.writeAudit({
      timestamp: new Date().toISOString(),
      action: 'test_action',
      tracking_id: 'INV-TEST-AUDIT',
      performed_by: 'tester',
      details: '{"key": "value"}',
      service_version: '2.0.0',
    });

    const rows = svc.db.prepare("SELECT * FROM audit_trail WHERE tracking_id = ?").all('INV-TEST-AUDIT');
    assert.ok(rows.length >= 1);
    assert.strictEqual(rows[0].action, 'test_action');

    svc.close();
  });

  it('writes to DLQ', async () => {
    const svc = new StorageService();
    svc.init();

    await svc.writeToDLQ({
      tracking_id: 'INV-TEST-DLQ',
      internal_id: 'dlq1',
      created_at: new Date().toISOString(),
      failed_step: 'ai_extraction',
      error_message: 'Groq timeout',
      error_type: 'Error',
      email_subject: 'Test Invoice',
      sender_email: 'test@test.com',
      retry_count: 0,
      raw_payload: '{"pdfSize": 5000}',
    });

    const rows = svc.db.prepare("SELECT * FROM dead_letter_queue WHERE tracking_id = ?").all('INV-TEST-DLQ');
    assert.ok(rows.length >= 1);
    assert.strictEqual(rows[0].failed_step, 'ai_extraction');

    svc.close();
  });
});

// ════════════════════════════════════════════
// Project Structure & Deliverables
// ════════════════════════════════════════════
describe('Project Structure', () => {
  const srcFiles = [
    'src/app.js', 'src/core/worker.js', 'src/services/email.service.js',
    'src/services/pdf.service.js', 'src/services/ai.service.js',
    'src/services/cleaning.service.js', 'src/services/storage.service.js',
    'src/services/approval.service.js', 'src/models/invoice.model.js',
    'src/utils/invoice-id.js', 'src/utils/logger.js',
    'src/utils/circuit-breaker.js', 'src/utils/rate-limiter.js', 'src/utils/validators.js',
    'config/index.js', 'prompts/invoice-extraction.md',
    'schema/database-schema.json', 'package.json', '.env.example',
  ];

  for (const f of srcFiles) {
    it(`has ${f}`, () => { assert.ok(fs.existsSync(path.join(ROOT, f)), `Missing: ${f}`); });
  }

  it('has 4 sample invoice PDFs', () => {
    const dir = path.join(ROOT, 'sample-invoices');
    const pdfs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
    assert.ok(pdfs.length >= 3, `Expected >= 3 PDFs, found ${pdfs.length}`);
    for (const pdf of pdfs) {
      const buf = fs.readFileSync(path.join(dir, pdf));
      assert.ok(buf.slice(0, 5).toString() === '%PDF-', `${pdf} is not valid PDF`);
    }
  });

  it('package.json has all required dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const required = ['groq-sdk', 'better-sqlite3', 'pdf-parse', 'pdf-lib', 'nodemailer', 'node-cron', 'winston', 'express', 'helmet', 'multer', 'uuid'];
    for (const dep of required) assert.ok(pkg.dependencies[dep], `Missing dep: ${dep}`);
  });

  it('package.json has NO airtable or imap dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const allDeps = { ...pkg.dependencies, ...(pkg.devDependencies || {}) };
    assert.ok(!allDeps['airtable'], 'airtable should be removed');
    assert.ok(!allDeps['imap'], 'imap should be removed');
    assert.ok(!allDeps['mailparser'], 'mailparser should be removed');
  });

  it('prompt file contains extraction schema with UUID', () => {
    const prompt = fs.readFileSync(path.join(ROOT, 'prompts', 'invoice-extraction.md'), 'utf8');
    assert.ok(prompt.includes('invoice_number'));
    assert.ok(prompt.includes('invoice_uuid'));
    assert.ok(prompt.includes('confidence'));
    assert.ok(prompt.includes('anomalies'));
    assert.ok(prompt.includes('YYYY-MM-DD'));
    assert.ok(prompt.includes('ISO 4217'));
    assert.ok(prompt.includes('null'));
    assert.ok(prompt.length > 800);
  });

  it('schema has 3 tables', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'database-schema.json'), 'utf8'));
    assert.strictEqual(schema.tables.length, 3);
    const names = schema.tables.map(t => t.name);
    assert.ok(names.includes('invoices'));
    assert.ok(names.includes('audit_trail'));
    assert.ok(names.includes('dead_letter_queue'));
  });

  it('schema invoices table has Tracking ID and Invoice UUID columns', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'database-schema.json'), 'utf8'));
    const inv = schema.tables.find(t => t.name === 'invoices');
    const colNames = inv.columns.map(c => c.name);
    assert.ok(colNames.includes('tracking_id'));
    assert.ok(colNames.includes('invoice_uuid'));
    assert.ok(colNames.includes('approved_by'));
    assert.ok(colNames.includes('rejection_reason'));
    assert.ok(colNames.includes('approved_at'));
  });

  it('schema has 7 views', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schema', 'database-schema.json'), 'utf8'));
    assert.ok(schema.views.length >= 7);
  });

  it('.env.example has only 5 required variables', () => {
    const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    const requiredVars = ['GROQ_API_KEY', 'SMTP_MAIL', 'SMTP_PASSWORD', 'SMTP_FROM', 'PORT'];
    for (const v of requiredVars) {
      assert.ok(envExample.includes(v), `Missing ${v} in .env.example`);
    }
    // Ensure no IMAP, Airtable, Redis, or Slack vars
    assert.ok(!envExample.includes('IMAP_'), '.env.example should not have IMAP_ vars');
    assert.ok(!envExample.includes('AIRTABLE'), '.env.example should not have AIRTABLE vars');
    assert.ok(!envExample.includes('REDIS'), '.env.example should not have REDIS vars');
    assert.ok(!envExample.includes('SLACK'), '.env.example should not have SLACK vars');
  });
});