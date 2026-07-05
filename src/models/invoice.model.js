/**
 * Invoice & Audit data models — Pure data structures with factory methods.
 * No database coupling — services handle persistence.
 */
const { generateTrackingId, generateInternalId } = require('../utils/invoice-id');

class Invoice {
  static create({ emailData, extractedData, trackingId, pdfBuffer }) {
    return {
      // ── System Fields ──
      tracking_id: trackingId || generateTrackingId(),
      internal_id: generateInternalId(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),

      // ── Extracted Invoice Fields ──
      vendor: null,
      vendor_uid: null,
      vendor_iban: null,
      invoice_number: null,
      invoice_date: null,
      due_date: null,
      net_amount: null,
      vat_amount: null,
      vat_percent: null,
      gross_amount: null,
      currency: 'EUR',
      cost_center: null,
      line_items: [],
      confidence: 0,
      anomalies: [],

      // ── Email Source Metadata ──
      source_email: emailData?.senderEmail || '',
      sender: emailData?.sender || '',
      sender_name: emailData?.senderName || '',
      email_subject: emailData?.subject || '',
      email_received: true,
      received_at: emailData?.receivedAt || new Date().toISOString(),

      // ── Workflow State ──
      application_status: 'Draft',
      selected_departments: [],
      send_for_approval: false,

      // ── Processing Metadata ──
      pdf_stored: false,
      pdf_filename: emailData?.pdfFilename || 'invoice.pdf',
      pdf_size_bytes: pdfBuffer?.length || 0,
      duplicate_of: null,

      // ── Approval Metadata ──
      approval_requested_at: null,
      approved_by: null,
      approved_at: null,
      rejection_reason: null,

      // ...spread extracted data (overwrites nulls above)
      ...(extractedData ? {
        vendor: extractedData.vendor,
        vendor_uid: extractedData.vendor_uid,
        vendor_iban: extractedData.vendor_iban,
        invoice_number: extractedData.invoice_number,
        invoice_date: extractedData.invoice_date,
        due_date: extractedData.due_date,
        net_amount: extractedData.net_amount,
        vat_amount: extractedData.vat_amount,
        vat_percent: extractedData.vat_percent,
        gross_amount: extractedData.gross_amount,
        currency: extractedData.currency || 'EUR',
        cost_center: extractedData.cost_center,
        line_items: extractedData.line_items || [],
        confidence: extractedData.confidence || 0,
        anomalies: extractedData.anomalies || [],
      } : {}),
    };
  }
}

class AuditEntry {
  static create({ action, trackingId, performedBy = 'system', details = {} }) {
    return {
      timestamp: new Date().toISOString(),
      action,
      tracking_id: trackingId || 'N/A',
      performed_by: performedBy,
      details: JSON.stringify(details),
      service_version: '2.0.0',
    };
  }
}

class DLQEntry {
  static create({ trackingId, step, error, emailData, rawPayload }) {
    return {
      tracking_id: trackingId || generateTrackingId(),
      internal_id: generateInternalId(),
      created_at: new Date().toISOString(),
      failed_step: step,
      error_message: String(error).substring(0, 5000),
      error_type: error?.constructor?.name || 'Error',
      email_subject: emailData?.subject || '',
      sender_email: emailData?.senderEmail || '',
      retry_count: 0,
      last_retry_at: null,
      resolved: false,
      resolved_at: null,
      raw_payload: rawPayload ? JSON.stringify(rawPayload).substring(0, 10000) : null,
    };
  }
}

module.exports = { Invoice, AuditEntry, DLQEntry };