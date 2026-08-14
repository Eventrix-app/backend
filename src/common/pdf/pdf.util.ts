import PDFDocument from 'pdfkit';

export type PdfDoc = PDFKit.PDFDocument;

// pdfkit's built-in fonts are WinAnsi-encoded and have no U+20B9 glyph, so a rupee sign
// renders as a blank box. Every document writes amounts through this instead.
export function formatMoney(amount: number | string, currency = 'INR'): string {
  const value = Number(amount);
  const safe = Number.isFinite(value) ? value : 0;
  return `${currency} ${safe.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const BRAND = {
  pink: '#FF3366',
  text: '#111827',
  muted: '#6B7280',
  rule: '#E5E7EB',
};

// pdfkit streams rather than returning a buffer, and an email attachment needs the whole
// thing in memory anyway — this is the seam that turns one into the other.
export function createPdfBuffer(build: (doc: PdfDoc) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Producer: 'Eventrix' } });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      build(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export function heading(doc: PdfDoc, text: string): void {
  doc.fillColor(BRAND.pink).font('Helvetica-Bold').fontSize(20).text(text);
  doc.moveDown(0.4);
}

export function sectionTitle(doc: PdfDoc, text: string): void {
  doc.moveDown(0.8);
  doc.fillColor(BRAND.text).font('Helvetica-Bold').fontSize(12).text(text.toUpperCase(), { characterSpacing: 0.6 });
  doc.moveDown(0.2);
  doc
    .strokeColor(BRAND.rule)
    .lineWidth(1)
    .moveTo(doc.x, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(0.5);
}

// Wrapped values, not a fixed-width column: an address or a long URL would otherwise run off
// the page. The label column is fixed so rows still line up.
export function keyValue(doc: PdfDoc, label: string, value: string): void {
  const labelWidth = 150;
  const startX = doc.page.margins.left;
  const valueWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right - labelWidth;
  const y = doc.y;

  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(10).text(label, startX, y, { width: labelWidth });
  const afterLabel = doc.y;

  doc.fillColor(BRAND.text).font('Helvetica').fontSize(10).text(value || '—', startX + labelWidth, y, { width: valueWidth });

  doc.y = Math.max(afterLabel, doc.y) + 4;
  doc.x = startX;
}

export function footerNote(doc: PdfDoc, text: string): void {
  doc.moveDown(1);
  doc.fillColor(BRAND.muted).font('Helvetica-Oblique').fontSize(9).text(text, { align: 'left' });
}
