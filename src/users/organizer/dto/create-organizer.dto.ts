import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class BankDetailsDto {
  @IsNotEmpty()
  @IsString()
  accountHolderName!: string;

  @IsNotEmpty()
  @IsString()
  bankName!: string;

  @IsNotEmpty()
  @IsString()
  accountNumber!: string;

  @IsNotEmpty()
  @IsString()
  ifscCode!: string;

  @IsNotEmpty()
  @IsString()
  branchName!: string;

  @IsNotEmpty()
  @IsString()
  accountType!: string;
}

export class CreateOrganizerDto {
  @IsNotEmpty()
  @IsString()
  username!: string;

  @IsNotEmpty()
  @IsEmail()
  email!: string;

  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  password!: string;

  @IsNotEmpty()
  @IsString()
  firstName!: string;

  @IsNotEmpty()
  @IsString()
  lastName!: string;

  @IsNotEmpty()
  @IsString()
  dateOfBirth!: string;

  @IsNotEmpty()
  @IsString()
  gender!: string;

  @IsNotEmpty()
  @IsString()
  phone!: string;

  @IsOptional()
  @IsString()
  alternatePhone!: string;

  @IsNotEmpty()
  @IsString()
  qualification!: string;

  @IsNotEmpty()
  @IsString()
  designation!: string;

  @IsNotEmpty()
  @IsString()
  department!: string;

  @IsOptional()
  @IsString()
  specialization!: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  experienceYears!: number;

  @IsNotEmpty()
  @IsString()
  addressType!: string;

  @IsNotEmpty()
  @IsString()
  addressLine!: string;

  @IsNotEmpty()
  @IsString()
  city!: string;

  @IsNotEmpty()
  @IsString()
  state!: string;

  @IsNotEmpty()
  @IsString()
  country!: string;

  @IsNotEmpty()
  @IsString()
  pincode!: string;

  @IsNotEmpty()
  @IsString()
  instituteName!: string;

  @IsNotEmpty()
  @IsString()
  instituteType!: string;

  @IsNotEmpty()
  @IsString()
  affiliationType!: string;

  @IsNotEmpty()
  @IsString()
  boardUniversityName!: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(1900)
  establishmentYear!: number;

  @IsNotEmpty()
  @IsString()
  registrationNumber!: string;

  @IsOptional()
  @IsString()
  accreditationDetails!: string;

  @IsOptional()
  @IsUrl()
  websiteUrl!: string;

  @IsNotEmpty()
  @IsString()
  headOfInstitute!: string;

  @IsNotEmpty()
  @IsNumber()
  commissionRate!: number;

  @IsNotEmpty()
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
