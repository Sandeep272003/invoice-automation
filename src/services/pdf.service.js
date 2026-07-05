/**
 * PDF Service — Step 2: Text extraction + UNIQUE INVOICE ID embedding.
 * Extracts text with pdf-parse, then stamps a tracking ID watermark onto the PDF
 * using pdf-lib before storing it. The stamped PDF ensures every stored invoice
 * is permanently linked to its tracking ID.
 */
const pdfParse = require('pdf-parse');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { logger, childLogger } = require('../utils/logger');
const path = require('path');
const fs = require('fs');
const config = require('../../config');

const ATTACH_DIR = config.paths.attachments;
if (!fs.existsSync(ATTACH_DIR)) fs.mkdirSync(ATTACH_DIR, { recursive: true });

class PDFService {

  /**
   * Extract text from a PDF buffer.
   * @param {Buffer} pdfBuffer
   * @param {string} filename
   * @param {string} trackingId
   * @returns {Promise<{text: string, pageCount: number}>}
   */
  async extractText(pdfBuffer, filename, trackingId) {
    const log = childLogger(trackingId);
    if (!pdfBuffer?.length) throw new Error('Empty PDF buffer');

    log.info(`Extracting text from "${filename}" (${(pdfBuffer.length / 1024).toFixed(1)}KB)`);

    const data = await pdfParse(pdfBuffer);
    const text = (data.text || '').trim();

    if (!text) {
      throw new Error('PDF contains no extractable text — may be scanned. OCR recommended.');
    }

    log.info(`Extracted ${text.length} chars, ${data.numpages} page(s)`);
    return { text, pageCount: data.numpages };
  }

  /**
   * Embed the tracking ID as a watermark on the PDF and save to disk.
   * The watermark appears on every page as a small semi-transparent stamp.
   *
   * @param {Buffer} originalPdf
   * @param {string} trackingId
   * @param {string} originalFilename
   * @returns {Promise<{stampedBuffer: Buffer, savedPath: string, savedFilename: string, size: number}>}
   */
  async stampAndSave(originalPdf, trackingId, originalFilename) {
    const log = childLogger(trackingId);
    log.info('Stamping tracking ID onto PDF...');

    const pdfDoc = await PDFDocument.load(originalPdf);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages = pdfDoc.getPages();
    const stampText = `ID: ${trackingId}`;
    const textWidth = font.widthOfTextAtSize(stampText, 7);

    for (const page of pages) {
      const { height, width } = page.getSize();
      page.drawText(stampText, {
        x: width - textWidth - 15,
        y: 15,
        size: 7,
        font,
        color: rgb(0.4, 0.4, 0.4),
        opacity: 0.6,
      });

      // Subtle border rectangle around the stamp
      page.drawRectangle({
        x: width - textWidth - 20,
        y: 12,
        width: textWidth + 10,
        height: 14,
        borderColor: rgb(0.6, 0.6, 0.6),
        borderWidth: 0.5,
        opacity: 0.3,
        color: undefined,
      });
    }

    const stampedBytes = await pdfDoc.save();
    const stampedBuffer = Buffer.from(stampedBytes);

    // Save to disk
    const safeName = originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const savedFilename = `${trackingId}_${safeName}`;
    const savedPath = path.join(ATTACH_DIR, savedFilename);
    fs.writeFileSync(savedPath, stampedBuffer);

    log.info(`Stamped PDF saved: ${savedPath} (${(stampedBuffer.length / 1024).toFixed(1)}KB)`);
    return { stampedBuffer, savedPath, savedFilename, size: stampedBuffer.length };
  }

  /** Get the stamped PDF from disk if it exists */
  getStampedPdf(trackingId, originalFilename) {
    const safeName = originalFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(ATTACH_DIR, `${trackingId}_${safeName}`);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
    return null;
  }

  get status() {
    return {
      attachmentsDir: ATTACH_DIR,
      storedFiles: fs.readdirSync(ATTACH_DIR).filter(f => f.endsWith('.pdf')).length,
    };
  }
}

module.exports = { PDFService };