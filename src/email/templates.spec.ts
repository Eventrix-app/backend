import {
  announcementEmail,
  bookingConfirmedEmail,
  eventCancelledEmail,
  eventChangedEmail,
  organizerFollowedEmail,
  organizerVerificationRejectedEmail,
  refundStatusEmail,
  waitlistPromotedEmail,
  welcomeEmail,
} from './templates';

// Regression test: display names, event titles, and admin-typed reasons all flow
// unescaped into these emails' HTML in the past — a display name like
// `<img src=x onerror=alert(1)>` would render as live markup in another user's inbox.
describe('email templates — HTML injection in interpolated values', () => {
  const XSS = '<img src=x onerror=alert(1)>';

  it('escapes a malicious first name in welcomeEmail', () => {
    const { html } = welcomeEmail(XSS);
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes a malicious follower name in organizerFollowedEmail', () => {
    const { html } = organizerFollowedEmail(XSS);
    expect(html).not.toContain(XSS);
  });

  it('escapes a malicious announcement title', () => {
    const { html } = announcementEmail(XSS);
    expect(html).not.toContain(XSS);
  });

  it('escapes a malicious event title and cancellation reason', () => {
    const { html } = eventCancelledEmail(XSS, XSS);
    expect(html).not.toContain(XSS);
  });

  it('escapes a malicious event title and booking reference', () => {
    const { html } = bookingConfirmedEmail(XSS, XSS, 1);
    expect(html).not.toContain(XSS);
  });

  it('escapes a malicious admin-typed rejection reason', () => {
    const { html } = organizerVerificationRejectedEmail(XSS);
    expect(html).not.toContain(XSS);
  });
});

// Regression tests for deep-linking (Frontend/src/navigation/linking.ts): when an id is
// available, the email should render a real eventrix:// link, not just static "open the
// app" text — and must keep working (backward-compatible signatures) for every existing
// call site that doesn't have an id to pass.
describe('email templates — deep links', () => {
  it('bookingConfirmedEmail renders a booking deep link when enrollmentId is provided', () => {
    const { html } = bookingConfirmedEmail('Music Fest', 'REF123', 2, 'enr-abc-123');
    expect(html).toContain('eventrix://booking/enr-abc-123');
  });

  it('bookingConfirmedEmail falls back to plain text when enrollmentId is omitted', () => {
    const { html } = bookingConfirmedEmail('Music Fest', 'REF123', 2);
    expect(html).not.toContain('eventrix://');
    expect(html).toContain('Open the');
  });

  it('eventCancelledEmail renders an event deep link when eventId is provided', () => {
    const { html } = eventCancelledEmail('Music Fest', 'Venue unavailable', 'evt-xyz-789');
    expect(html).toContain('eventrix://event/evt-xyz-789');
  });

  it('waitlistPromotedEmail renders a booking deep link when enrollmentId is provided', () => {
    const { html } = waitlistPromotedEmail('enr-def-456');
    expect(html).toContain('eventrix://booking/enr-def-456');
  });

  it('refundStatusEmail renders a booking deep link for a non-"requested" status', () => {
    const { html } = refundStatusEmail('processed', 'enr-ghi-789');
    expect(html).toContain('eventrix://booking/enr-ghi-789');
  });

  it('refundStatusEmail omits the deep link for the initial "requested" status regardless of enrollmentId', () => {
    const { html } = refundStatusEmail('requested', 'enr-ghi-789');
    expect(html).not.toContain('eventrix://');
  });

  it('eventChangedEmail renders an event deep link when eventId is provided', () => {
    const { html } = eventChangedEmail('evt-jkl-321');
    expect(html).toContain('eventrix://event/evt-jkl-321');
  });

  it('eventChangedEmail falls back to plain text when eventId is omitted', () => {
    const { html } = eventChangedEmail();
    expect(html).not.toContain('eventrix://');
  });

  it('URL-encodes an id so it can never break out of the href attribute', () => {
    const { html } = eventCancelledEmail('Music Fest', undefined, '"><script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
