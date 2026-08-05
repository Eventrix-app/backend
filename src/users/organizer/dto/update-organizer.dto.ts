import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, IsUrl, Matches, Max, MinLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { VerificationLevel } from '../../../entities/organizer.entity';

export class UpdateOrganizerDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  // Required alongside `password` — proves the caller actually knows the current
  // password. Checked in OrganizerService.update.
  @IsOptional()
  @IsString()
  currentPassword?: string;

  // Previously a dead field on the Organizer entity with no way to set it — the
  // client obtains this URL via POST /uploads/signed-url (purpose: "company-logo"),
  // then saves it here. See multipart.md §3.4.
  @IsOptional()
  @IsUrl()
  companyLogoUrl?: string;

  // Supplier GSTIN for tax invoices. Self-service: the organizer knows their own
  // registration number, and it appears on invoices issued to their attendees.
  //
  // Validated against the statutory 15-character format rather than accepting free text —
  // a malformed GSTIN on an issued invoice is a compliance problem, not a display bug.
  // Uppercased before validation so a lowercase entry is corrected rather than rejected.
  // An empty string clears it (for an organizer who deregisters); null/undefined leaves
  // it untouched, matching how every other optional field on this DTO behaves.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^$|^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, {
    message: 'gstin must be a valid 15-character GSTIN',
  })
  gstin?: string;

  // Admin-only fields — enforced in OrganizerController, not self-service.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  commissionFlatFee?: number;

  @IsOptional()
  @IsEnum(VerificationLevel)
  verificationLevel?: VerificationLevel;

  @IsOptional()
  @IsBoolean()
  autoApproveEvents?: boolean;
}
