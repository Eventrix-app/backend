import { createPdfBuffer, heading, keyValue, sectionTitle, BRAND, type PdfDoc } from './pdf.util';

export interface TicketPdfInput {
  eventTitle: string;
  bookingReference: string;
  ticketCode: string;
  quantity: number;
  eventDate?: string;
  startTime?: string;
  venueName?: string;
  attendeeName?: string;
  // Rendered PNG rather than the code itself — the caller already generates one for the
  // email, so the two can never encode different values.
  qrPng: Buffer;
}

function formatEventDate(date?: string, startTime?: string): string {
  if (!date) return '—';
  const parsed = new Date(startTime ? `${date}T${startTime}` : date);
  if (Number.isNaN(parsed.getTime())) return startTime ? `${date} ${startTime}` : date;
  return parsed.toLocaleString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: startTime ? 'numeric' : undefined,
    minute: startTime ? '2-digit' : undefined,
  });
}

// The document an attendee actually presents at the door, so the QR is the largest element
// and the booking reference is readable without it in case the scanner is down.
export function renderTicketPdf(input: TicketPdfInput): Promise<Buffer> {
  return createPdfBuffer((doc: PdfDoc) => {
    heading(doc, 'Your ticket');
    doc.fillColor(BRAND.text).font('Helvetica-Bold').fontSize(15).text(input.eventTitle);

    sectionTitle(doc, 'Booking details');
    keyValue(doc, 'Booking reference', input.bookingReference || '—');
    keyValue(doc, 'Tickets', String(input.quantity));
    if (input.attendeeName) keyValue(doc, 'Attendee', input.attendeeName);
    keyValue(doc, 'Date & time', formatEventDate(input.eventDate, input.startTime));
    keyValue(doc, 'Venue', input.venueName ?? '—');

    sectionTitle(doc, 'Entry code');
    doc.moveDown(0.3);

    const qrSize = 200;
    const centreX = (doc.page.width - qrSize) / 2;
    doc.image(input.qrPng, centreX, doc.y, { width: qrSize, height: qrSize });
    doc.y += qrSize + 12;

    doc
      .fillColor(BRAND.muted)
      .font('Helvetica')
      .fontSize(10)
      .text('Show this code at the entrance. It is unique to this booking.', { align: 'center' });
    doc.moveDown(0.4);
    doc.fillColor(BRAND.text).font('Courier-Bold').fontSize(12).text(input.ticketCode, { align: 'center' });

    doc.moveDown(1.5);
    doc
      .fillColor(BRAND.muted)
      .font('Helvetica-Oblique')
      .fontSize(9)
      .text('Keep this ticket private — anyone holding this code can check in with it.', { align: 'center' });
  });
}
