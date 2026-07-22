import {
  announcementEmail,
  bookingConfirmedEmail,
  eventCancelledEmail,
  organizerFollowedEmail,
  organizerVerificationRejectedEmail,
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
