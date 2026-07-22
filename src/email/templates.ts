// One render function per email purpose, each returning its own subject + purpose-specific
// body — sharing only the chrome (brand header/footer) via wrapEmail. Kept as plain
// functions (not an Injectable) since rendering has no dependencies: AuthService and
// NotificationService import these directly, same as they'd build a string inline before.
const BRAND_COLOR = '#FF3366';

export interface RenderedEmail {
  subject: string;
  html: string;
}

// Every render* function below interpolates values that ultimately trace back to
// user/organizer/admin-entered text (display names, event titles, rejection reasons) —
// escape before interpolating so a display name like `<img src=x onerror=...>` can't
// inject markup into an email that otherwise looks like it's really from Eventrix.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapEmail(heading: string, bodyHtml: string): string {
  return `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1A1A1A;">
      <div style="padding: 24px 0; text-align: center; border-bottom: 2px solid ${BRAND_COLOR};">
        <span style="font-size: 22px; font-weight: 700; color: ${BRAND_COLOR};">Eventrix</span>
      </div>
      <div style="padding: 32px 8px;">
        <h2 style="margin: 0 0 16px; font-size: 18px; color: #1A1A1A;">${heading}</h2>
        ${bodyHtml}
      </div>
      <div style="padding: 16px 8px; border-top: 1px solid #EAEAEA; color: #8A8A8A; font-size: 12px; text-align: center;">
        <p style="margin: 0;">You're receiving this because you have an Eventrix account.</p>
        <p style="margin: 4px 0 0;">Need help? Contact us anytime at support@eventrix.app</p>
      </div>
    </div>
  `;
}

// --- Auth (auth.service.ts) ---

export function welcomeEmail(firstName: string): RenderedEmail {
  return {
    subject: 'Welcome to Eventrix!',
    html: wrapEmail('Welcome to Eventrix!', `
      <p>Hi ${escapeHtml(firstName || 'there')},</p>
      <p>Welcome to Eventrix — your account is ready to go. Start exploring events near you, or create your own event to share with the community.</p>
    `),
  };
}

export function passwordResetOtpEmail(otp: string, ttlMinutes: number): RenderedEmail {
  return {
    subject: 'Your Eventrix password reset code',
    html: wrapEmail('Password reset code', `
      <p>Your password reset code is:</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:4px;color:${BRAND_COLOR};">${otp}</p>
      <p>This code expires in ${ttlMinutes} minutes. If you didn't request this, you can ignore this email.</p>
    `),
  };
}

export function passwordChangedEmail(): RenderedEmail {
  return {
    subject: 'Your Eventrix password was changed',
    html: wrapEmail('Password changed', `
      <p>Your password was just changed.</p>
      <p>If this was you, no action is needed. If you didn't make this change, please reset your password immediately and contact support.</p>
    `),
  };
}

export function passwordResetConfirmationEmail(): RenderedEmail {
  return {
    subject: 'Your Eventrix password was reset',
    html: wrapEmail('Password reset', `
      <p>Your password was just reset using the "Forgot password" flow.</p>
      <p>If this was you, no action is needed. If you didn't request this, your account may be compromised — contact support immediately.</p>
    `),
  };
}

// --- Notifications (notification.service.ts) ---

export function eventChangedEmail(): RenderedEmail {
  return {
    subject: 'Event updated',
    html: wrapEmail('An event you booked has changed', `
      <p>One of the events you're attending has been updated — check the details in the app to see what changed.</p>
    `),
  };
}

export function waitlistPromotedEmail(): RenderedEmail {
  return {
    subject: "You're in!",
    html: wrapEmail("You're off the waitlist!", `
      <p>A spot opened up and you've been moved off the waitlist. Your ticket is now confirmed — check My Bookings for details.</p>
    `),
  };
}

export function refundStatusEmail(status: string): RenderedEmail {
  if (status === 'requested') {
    return {
      subject: 'Refund request received',
      html: wrapEmail('Refund request received', `<p>We've received your refund request and will review it shortly.</p>`),
    };
  }
  return {
    subject: 'Refund update',
    html: wrapEmail('Refund status update', `<p>Your refund is now "<strong>${status}</strong>".</p>`),
  };
}

export function announcementEmail(title: string): RenderedEmail {
  return {
    subject: 'Event announcement',
    html: wrapEmail('New announcement', `<p>${escapeHtml(title)}</p>`),
  };
}

export function organizerFollowedEmail(followerName: string): RenderedEmail {
  return {
    subject: 'New follower',
    html: wrapEmail('You have a new follower', `<p><strong>${escapeHtml(followerName)}</strong> started following you on Eventrix.</p>`),
  };
}

export function eventCancelledEmail(eventTitle: string, reason?: string): RenderedEmail {
  const reasonHtml = reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : '';
  return {
    subject: 'Event cancelled',
    html: wrapEmail('Event cancelled', `
      <p>"${escapeHtml(eventTitle)}" has been cancelled.</p>
      ${reasonHtml}
      <p>If you paid for this booking, request a refund from My Bookings in the app.</p>
    `),
  };
}

export function bookingConfirmedEmail(eventTitle: string, bookingReference: string, quantity: number): RenderedEmail {
  return {
    subject: 'Booking confirmed!',
    html: wrapEmail('Booking confirmed', `
      <p>You're confirmed for <strong>${escapeHtml(eventTitle)}</strong> (${quantity} ticket${quantity === 1 ? '' : 's'}).</p>
      <p>Booking reference: <strong>${escapeHtml(bookingReference)}</strong></p>
      <p>View your ticket anytime in the app.</p>
    `),
  };
}

export function organizerVerificationApprovedEmail(): RenderedEmail {
  return {
    subject: "You're verified!",
    html: wrapEmail("You're verified!", `<p>Your organizer verification was approved — you can now create and publish events on Eventrix.</p>`),
  };
}

export function organizerVerificationRejectedEmail(reason: string): RenderedEmail {
  const reasonHtml = reason ? `<p><strong>Reason:</strong> ${escapeHtml(reason)}</p>` : '';
  return {
    subject: 'Verification needs another look',
    html: wrapEmail('Verification needs another look', `
      <p>Your organizer verification wasn't approved this time.</p>
      ${reasonHtml}
      <p>You can update your details and resubmit from your profile.</p>
    `),
  };
}
