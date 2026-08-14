import { createPdfBuffer, footerNote, heading, keyValue, sectionTitle, BRAND, type PdfDoc } from './pdf.util';

export interface DataExportPayload {
  exportedAt: string;
  account: Record<string, unknown>;
  interests: { id: string; name: string }[];
  organizerProfiles: Record<string, unknown>[];
  followedOrganizerIds: string[];
  note: string;
}

// Field order is deliberate — identity first, then contact, then settings — so the document
// reads like a profile rather than the column order of the users table.
const ACCOUNT_FIELDS: [key: string, label: string][] = [
  ['id', 'Account ID'],
  ['fullName', 'Full name'],
  ['email', 'Email address'],
  ['phoneNumber', 'Mobile number'],
  ['dateOfBirth', 'Date of birth'],
  ['gender', 'Gender'],
  ['location', 'Location'],
  ['latitude', 'Latitude'],
  ['longitude', 'Longitude'],
  ['bio', 'Bio'],
  ['profilePictureUrl', 'Profile picture'],
  ['roles', 'Account roles'],
  ['isEmailVerified', 'Email verified'],
  ['hasCompletedOnboarding', 'Completed onboarding'],
  ['pushEnabled', 'Push notifications'],
  ['emailEnabled', 'Email notifications'],
  ['notificationPrefs', 'Notification preferences'],
  ['createdAt', 'Account created'],
  ['updatedAt', 'Last updated'],
];

const ORGANIZER_FIELDS: [key: string, label: string][] = [
  ['id', 'Organizer ID'],
  ['companyName', 'Company name'],
  ['companyDescription', 'Description'],
  ['companyWebsite', 'Website'],
  ['verificationLevel', 'Verification level'],
  ['commissionRate', 'Commission rate (%)'],
  ['commissionFlatFee', 'Commission flat fee'],
  ['createdAt', 'Created'],
];

// Renders the value a person expects to read, not the JSON spelling of it: booleans as
// Yes/No, empty as an em dash, and objects flattened rather than printed as [object Object].
function present(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${present(v)}`)
      .join(', ');
  }
  return String(value);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toUTCString();
}

export function renderDataExportPdf(payload: DataExportPayload): Promise<Buffer> {
  return createPdfBuffer((doc: PdfDoc) => {
    heading(doc, 'Your Eventrix data export');
    doc.fillColor(BRAND.muted).font('Helvetica').fontSize(10).text(`Generated ${formatDate(payload.exportedAt)}`);

    sectionTitle(doc, 'Account');
    for (const [key, label] of ACCOUNT_FIELDS) {
      keyValue(doc, label, present(payload.account[key]));
    }

    sectionTitle(doc, 'Interests');
    if (payload.interests.length === 0) {
      keyValue(doc, 'Selected interests', '—');
    } else {
      keyValue(doc, 'Selected interests', payload.interests.map((i) => i.name).join(', '));
    }

    sectionTitle(doc, 'Organizer profiles');
    if (payload.organizerProfiles.length === 0) {
      keyValue(doc, 'Organizer profiles', 'None');
    } else {
      payload.organizerProfiles.forEach((profile, index) => {
        if (index > 0) doc.moveDown(0.5);
        for (const [key, label] of ORGANIZER_FIELDS) {
          keyValue(doc, label, present(profile[key]));
        }
      });
    }

    sectionTitle(doc, 'Organizers you follow');
    keyValue(doc, 'Followed organizers', payload.followedOrganizerIds.length ? String(payload.followedOrganizerIds.length) : 'None');
    if (payload.followedOrganizerIds.length) {
      keyValue(doc, 'Organizer IDs', payload.followedOrganizerIds.join(', '));
    }

    footerNote(doc, payload.note);
  });
}
