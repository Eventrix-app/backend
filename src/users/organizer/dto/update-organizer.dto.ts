import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString, IsUrl, Max, MinLength, Min } from 'class-validator';
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

  // Previously a dead field on the Organizer entity with no way to set it — the
  // client obtains this URL via POST /uploads/signed-url (purpose: "company-logo"),
  // then saves it here. See multipart.md §3.4.
  @IsOptional()
  @IsUrl()
  companyLogoUrl?: string;

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
