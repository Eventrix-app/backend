import { ConflictException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { CreateOrganizerDto } from './dto/create-organizer.dto';
import { UpdateOrganizerDto } from './dto/update-organizer.dto';
import { User } from '../../entities/user.entity';
import { Organizer } from '../../entities/organizer.entity';

const BCRYPT_ROUNDS = 10;

export interface OrganizerRecord {
  id: string;
  userId: string;
  username: string;
  email: string;
  role: 'ORGANIZER';
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: string;
  phone: string;
  alternatePhone?: string;
  qualification: string;
  designation: string;
  department: string;
  specialization?: string;
  experienceYears: number;
  addressType: string;
  addressLine: string;
  city: string;
  state: string;
  country: string;
  pincode: string;
  instituteName: string;
  instituteType: string;
  affiliationType: string;
  boardUniversityName: string;
  establishmentYear: number;
  registrationNumber: string;
  accreditationDetails?: string;
  websiteUrl?: string;
  headOfInstitute: string;
  commissionRate: number;
  settlementCycleDays: number;
  verificationDocumentsUrl?: string;
  instructorProfileImageUrl?: string;
  govtIdProofUrl?: string;
  bankDetails?: {
    accountHolderName: string;
    bankName: string;
    accountNumber: string;
    ifscCode: string;
    branchName: string;
    accountType: string;
  };
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class OrganizerService {
  private readonly logger = new Logger(OrganizerService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Organizer)
    private readonly organizersRepository: Repository<Organizer>,
  ) {}

  /**
   * Organizer-specific extra fields are stored JSON-encoded in the user's bio column.
   */
  private buildMeta(dto: Partial<CreateOrganizerDto>): Record<string, any> {
    return {
      username: dto.username ?? '',
      alternatePhone: dto.alternatePhone ?? '',
      qualification: dto.qualification ?? '',
      designation: dto.designation ?? '',
      department: dto.department ?? '',
      specialization: dto.specialization ?? '',
      experienceYears: dto.experienceYears ?? 0,
      addressType: dto.addressType ?? '',
      addressLine: dto.addressLine ?? '',
      city: dto.city ?? '',
      state: dto.state ?? '',
      country: dto.country ?? '',
      pincode: dto.pincode ?? '',
      instituteName: dto.instituteName ?? '',
      instituteType: dto.instituteType ?? '',
      affiliationType: dto.affiliationType ?? '',
      boardUniversityName: dto.boardUniversityName ?? '',
      establishmentYear: dto.establishmentYear ?? 0,
      registrationNumber: dto.registrationNumber ?? '',
      accreditationDetails: dto.accreditationDetails ?? '',
      headOfInstitute: dto.headOfInstitute ?? '',
      commissionRate: dto.commissionRate ?? 0,
      settlementCycleDays: dto.settlementCycleDays ?? 0,
      verificationDocumentsUrl: dto.verificationDocumentsUrl ?? '',
      instructorProfileImageUrl: dto.instructorProfileImageUrl ?? '',
      govtIdProofUrl: dto.govtIdProofUrl ?? '',
      bankDetails: dto.bankDetails ?? null,
      status: dto.status ?? 'PENDING',
    };
  }

  private parseMeta(bio: string | null): Record<string, any> {
    try {
      return bio ? JSON.parse(bio) : {};
    } catch {
      return {};
    }
  }

  private mapToRecord(user: User, organizer: Organizer): OrganizerRecord {
    const meta = this.parseMeta(user.bio);
    const [firstName, ...lastNames] = (user.fullName || '').split(' ');
    return {
      id: organizer.id,
      userId: user.id,
      username: meta['username'] || user.email.split('@')[0],
      email: user.email,
      role: 'ORGANIZER',
      firstName: firstName || '',
      lastName: lastNames.join(' ') || '',
      dateOfBirth: user.dateOfBirth || '',
      gender: user.gender || '',
      phone: user.phoneNumber || '',
      alternatePhone: meta['alternatePhone'] || undefined,
      qualification: meta['qualification'] || '',
      designation: meta['designation'] || '',
      department: meta['department'] || '',
      specialization: meta['specialization'] || undefined,
      experienceYears: meta['experienceYears'] || 0,
      addressType: meta['addressType'] || '',
      addressLine: meta['addressLine'] || '',
      city: meta['city'] || '',
      state: meta['state'] || '',
      country: meta['country'] || '',
      pincode: meta['pincode'] || '',
      instituteName: meta['instituteName'] || organizer.companyName || '',
      instituteType: meta['instituteType'] || '',
      affiliationType: meta['affiliationType'] || '',
      boardUniversityName: meta['boardUniversityName'] || '',
      establishmentYear: meta['establishmentYear'] || 0,
      registrationNumber: meta['registrationNumber'] || '',
      accreditationDetails: meta['accreditationDetails'] || undefined,
      websiteUrl: organizer.companyWebsite || undefined,
      headOfInstitute: meta['headOfInstitute'] || '',
      commissionRate: meta['commissionRate'] || 0,
      settlementCycleDays: meta['settlementCycleDays'] || 0,
      verificationDocumentsUrl: meta['verificationDocumentsUrl'] || undefined,
      instructorProfileImageUrl: meta['instructorProfileImageUrl'] || undefined,
      govtIdProofUrl: meta['govtIdProofUrl'] || undefined,
      bankDetails: meta['bankDetails'] || undefined,
      status: meta['status'] || 'PENDING',
      isActive: !user.deletedAt,
      createdAt: organizer.createdAt.toISOString(),
      updatedAt: organizer.updatedAt.toISOString(),
    };
  }

  async create(dto: CreateOrganizerDto): Promise<OrganizerRecord> {
    const existing = await this.usersRepository.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const fullName = `${dto.firstName} ${dto.lastName}`.trim();
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // 1. Insert into users table
    const user = this.usersRepository.create({
      email: dto.email,
      fullName,
      phoneNumber: dto.phone,
      passwordHash,
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth,
      profilePictureUrl: dto.instructorProfileImageUrl,
      roles: ['organizer'],
      bio: JSON.stringify(this.buildMeta(dto)),
      isEmailVerified: false,
      isPhoneVerified: false,
    });
    const savedUser = await this.usersRepository.save(user);
    this.logger.log(`Created organizer user in database: ${savedUser.email}`);

    // 2. Insert into organizers table linked to the user
    const organizer = this.organizersRepository.create({
      userId: savedUser.id,
      companyName: dto.instituteName,
      companyDescription: dto.accreditationDetails ?? null,
      companyWebsite: dto.websiteUrl ?? null,
      companyLogoUrl: dto.instructorProfileImageUrl ?? null,
      verified: false,
    });
    const savedOrganizer = await this.organizersRepository.save(organizer);
    this.logger.log(
      `Created organizer profile in database: id=${savedOrganizer.id}`,
    );

    return this.mapToRecord(savedUser, savedOrganizer);
  }

  async findAll(): Promise<OrganizerRecord[]> {
    const organizers = await this.organizersRepository.find({
      relations: ['user'],
    });
    return organizers
      .filter((o) => o.user && !o.user.deletedAt)
      .map((o) => this.mapToRecord(o.user, o));
  }

  async findOne(id: string): Promise<OrganizerRecord> {
    const organizer = await this.organizersRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!organizer || !organizer.user || organizer.user.deletedAt) {
      throw new NotFoundException(`Organizer with id ${id} not found`);
    }
    return this.mapToRecord(organizer.user, organizer);
  }

  async update(id: string, dto: UpdateOrganizerDto): Promise<OrganizerRecord> {
    const organizer = await this.organizersRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!organizer || !organizer.user || organizer.user.deletedAt) {
      throw new NotFoundException(`Organizer with id ${id} not found`);
    }

    const user = organizer.user;

    // Update user columns
    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const [curFirst, ...curLast] = (user.fullName || '').split(' ');
      user.fullName =
        `${dto.firstName ?? curFirst} ${dto.lastName ?? curLast.join(' ')}`.trim();
    }
    if (dto.phone !== undefined) user.phoneNumber = dto.phone;
    if (dto.password)
      user.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Merge meta in bio — include status before persisting
    const existingMeta = this.parseMeta(user.bio);
    const patch = this.buildMeta(dto);
    for (const key of Object.keys(patch)) {
      if ((dto as unknown as Record<string, unknown>)[key] !== undefined) {
        existingMeta[key] = patch[key];
      }
    }
    if (dto.instituteName !== undefined) {
      organizer.companyName = dto.instituteName;
    }
    if (dto.websiteUrl !== undefined) {
      organizer.companyWebsite = dto.websiteUrl;
    }

    // #region agent log
    fetch('http://127.0.0.1:7900/ingest/60f87d47-04ee-4c91-8969-d73cd3960c98',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'947f72'},body:JSON.stringify({sessionId:'947f72',runId:'post-fix',hypothesisId:'H3',location:'organizer.service.ts:update',message:'organizer meta before bio save',data:{statusInDto:dto.status,statusInMeta:existingMeta['status'],organizerId:id},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    user.bio = JSON.stringify(existingMeta);
    const savedUser = await this.usersRepository.save(user);
    const savedOrganizer = await this.organizersRepository.save(organizer);

    // #region agent log
    fetch('http://127.0.0.1:7900/ingest/60f87d47-04ee-4c91-8969-d73cd3960c98',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'947f72'},body:JSON.stringify({sessionId:'947f72',runId:'post-fix',hypothesisId:'H3',location:'organizer.service.ts:update',message:'organizer bio persisted',data:{savedBioStatus:this.parseMeta(savedUser.bio)['status'],organizerId:id},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    this.logger.log(`Updated organizer in database: ${savedUser.email}`);
    return this.mapToRecord(savedUser, savedOrganizer);
  }

  async remove(id: string): Promise<void> {
    const organizer = await this.organizersRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!organizer || !organizer.user || organizer.user.deletedAt) {
      throw new NotFoundException(`Organizer with id ${id} not found`);
    }
    // Soft-delete the user (cascades logically — organizer profile remains linked)
    await this.usersRepository.softRemove(organizer.user);
    this.logger.log(
      `Soft-deleted organizer user in database: ${organizer.user.email}`,
    );
  }
}
