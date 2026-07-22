import { IsNotEmpty, IsString } from 'class-validator';

// Submitted (or resubmitted, after a rejection) by the organizer applicant themselves —
// see #7: a user must pass this admin-reviewed check before they can create events.
// Document fields are storage paths returned by POST /uploads/signed-url with purpose
// identity-proof / address-proof / pan-or-aadhaar (private bucket, not public URLs).
export class SubmitVerificationDto {
  @IsString()
  @IsNotEmpty()
  fullName!: string;

  @IsString()
  @IsNotEmpty()
  companyName!: string;

  @IsString()
  @IsNotEmpty()
  identityProofUrl!: string;

  @IsString()
  @IsNotEmpty()
  addressProofUrl!: string;

  @IsString()
  @IsNotEmpty()
  panOrAadhaarUrl!: string;

  @IsString()
  @IsNotEmpty()
  upiId!: string;
}

export class RejectVerificationDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
