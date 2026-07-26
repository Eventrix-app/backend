import { IsEnum, IsIn } from 'class-validator';

// One generalized upload intent per client-facing image field. Adding a new image
// field elsewhere in the app means adding one entry here, not a new endpoint —
// see multipart.md §3.1.
export enum UploadPurpose {
  PROFILE_PICTURE = 'profile-picture',
  EVENT_IMAGE = 'event-image',
  EVENT_COVER = 'event-cover',
  COMPANY_LOGO = 'company-logo',
  // KYC documents for organizer verification (#7) — unlike every other purpose above,
  // these land in a private bucket (see UploadsService's PURPOSE_CONFIG.isPrivate) since
  // they're sensitive PII, not routinely-displayed public assets.
  IDENTITY_PROOF = 'identity-proof',
  ADDRESS_PROOF = 'address-proof',
  PAN_OR_AADHAAR = 'pan-or-aadhaar',
  // Reel/short media — unlike every purpose above, any authenticated user may request
  // this one (see UploadsService.PURPOSE_CONFIG's allowedRoles: null), not just
  // organizers/admins, since reel uploaders are attendees.
  REEL_VIDEO = 'reel-video',
}

// Deliberately a fixed allow-list, not a generic "image/*" pattern — only the formats
// clients actually need to upload. UploadsService's extension map (uploads.service.ts)
// must stay in sync with this exact list.
export const ALLOWED_UPLOAD_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/heic', 'image/webp', 'video/mp4', 'video/quicktime'] as const;
export type AllowedUploadContentType = (typeof ALLOWED_UPLOAD_CONTENT_TYPES)[number];

export class CreateSignedUrlDto {
  @IsEnum(UploadPurpose, {
    message: `purpose must be one of: ${Object.values(UploadPurpose).join(', ')}`,
  })
  purpose!: UploadPurpose;

  @IsIn(ALLOWED_UPLOAD_CONTENT_TYPES, {
    message: `contentType must be one of: ${ALLOWED_UPLOAD_CONTENT_TYPES.join(', ')}`,
  })
  contentType!: AllowedUploadContentType;
}
