import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class BankDetailsDto {
  @IsOptional()
  @IsString()
  accountHolderName!: string;

  @IsOptional()
  @IsString()
  bankName!: string;

  @IsOptional()
  @IsString()
  accountNumber!: string;

  @IsOptional()
  @IsString()
  ifscCode!: string;

  @IsOptional()
  @IsString()
  branchName!: string;

  @IsOptional()
  @IsString()
  accountType!: string;
}

export class UpdateOrganizerDto {
  @IsOptional()
  @IsString()
  username!: string;

  @IsOptional()
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  firstName!: string;

  @IsOptional()
  @IsString()
  lastName!: string;

  @IsOptional()
  @IsString()
  dateOfBirth!: string;

  @IsOptional()
  @IsString()
  gender!: string;

  @IsOptional()
  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  alternatePhone!: string;

  @IsOptional()
  @IsString()
  qualification!: string;

  @IsOptional()
  @IsString()
  designation!: string;

  @IsOptional()
  @IsString()
  department!: string;

  @IsOptional()
  @IsString()
  specialization!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  experienceYears!: number;

  @IsOptional()
  @IsString()
  addressType!: string;

  @IsOptional()
  @IsString()
  addressLine!: string;

  @IsOptional()
  @IsString()
  city!: string;

  @IsOptional()
  @IsString()
  state!: string;

  @IsOptional()
  @IsString()
  country!: string;

  @IsOptional()
  @IsString()
  pincode!: string;

  @IsOptional()
  @IsString()
  instituteName!: string;

  @IsOptional()
  @IsString()
  instituteType!: string;

  @IsOptional()
  @IsString()
  affiliationType!: string;

  @IsOptional()
  @IsString()
  boardUniversityName!: string;

  @IsOptional()
  @IsNumber()
  @Min(1900)
  establishmentYear!: number;

  @IsOptional()
  @IsString()
  registrationNumber!: string;

  @IsOptional()
  @IsString()
  accreditationDetails!: string;

  @IsOptional()
  @IsUrl()
  websiteUrl!: string;

  @IsOptional()
  @IsString()
  headOfInstitute!: string;

  @IsOptional()
  @IsNumber()
  commissionRate!: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  settlementCycleDays!: number;

  @IsOptional()
  @IsUrl()
  verificationDocumentsUrl!: string;

  @IsOptional()
  @IsUrl()
  instructorProfileImageUrl!: string;

  @IsOptional()
  @IsUrl()
  govtIdProofUrl!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BankDetailsDto)
  bankDetails!: BankDetailsDto;

  @IsOptional()
  @IsEnum(['PENDING', 'APPROVED', 'REJECTED'])
  status!: 'PENDING' | 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsBoolean()
  isActive!: boolean;
}
