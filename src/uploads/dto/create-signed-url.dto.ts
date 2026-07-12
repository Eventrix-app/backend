import { IsEnum, IsIn } from 'class-validator';

// One generalized upload intent per client-facing image field. Adding a new image
// field elsewhere in the app means adding one entry here, not a new endpoint —
// see multipart.md §3.1.
export enum UploadPurpose {
  PROFILE_PICTURE = 'profile-picture',
  EVENT_IMAGE = 'event-image',
  EVENT_COVER = 'event-cover',
  COMPANY_LOGO = 'company-logo',
}

// Deliberately a fixed allow-list, not a generic "image/*" pattern — only the formats
// clients actually need to upload. UploadsService's extension map (uploads.service.ts)
// must stay in sync with this exact list.
export const ALLOWED_UPLOAD_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/heic', 'image/webp'] as const;
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
