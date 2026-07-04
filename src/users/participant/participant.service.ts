import { ConflictException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { In } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { CreateParticipantDto } from './dto/create-participant.dto';
import { UpdateParticipantDto } from './dto/update-participant.dto';
import { User } from '../../entities/user.entity';

const BCRYPT_ROUNDS = 10;

export interface ParticipantRecord {
  id: string;
  username: string;
  email: string;
  role: 'PARTICIPANT';
  firstName: string;
  lastName: string;
  gender: string;
  dateOfBirth: string;
  phone: string;
  profileImageUrl?: string;
  addressType: string;
  addressLine: string;
  city: string;
  state: string;
  country: string;
  pincode: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ParticipantService {
  private readonly logger = new Logger(ParticipantService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  /**
   * Participant-specific fields (address, pincode, etc.) don't have
   * dedicated columns in the 'users' table. We store them JSON-encoded
   * in the `bio` column so no schema changes are needed.
   */
  private buildMeta(dto: Partial<CreateParticipantDto>): string {
    return JSON.stringify({
      username: dto.username ?? '',
      addressType: dto.addressType ?? '',
      addressLine: dto.addressLine ?? '',
      city: dto.city ?? '',
      state: dto.state ?? '',
      country: dto.country ?? '',
      pincode: dto.pincode ?? '',
    });
  }

  private parseMeta(bio: string | null): Record<string, string> {
    try {
      return bio ? JSON.parse(bio) : {};
    } catch {
      return {};
    }
  }

  private mapUserToParticipantRecord(user: User): ParticipantRecord {
    const meta = this.parseMeta(user.bio);
    const [firstName, ...lastNames] = (user.fullName || '').split(' ');
    return {
      id: user.id,
      username: meta['username'] || user.email.split('@')[0],
      email: user.email,
      role: 'PARTICIPANT',
      firstName: firstName || '',
      lastName: lastNames.join(' ') || '',
      gender: user.gender || '',
      dateOfBirth: user.dateOfBirth || '',
      phone: user.phoneNumber || '',
      profileImageUrl: user.profilePictureUrl || undefined,
      addressType: meta['addressType'] || '',
      addressLine: meta['addressLine'] || '',
      city: meta['city'] || '',
      state: meta['state'] || '',
      country: meta['country'] || '',
      pincode: meta['pincode'] || '',
      isActive: !user.deletedAt,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private mergeMetaPatch(
    existingMeta: Record<string, string>,
    dto: Partial<CreateParticipantDto>,
  ): Record<string, string> {
    const patch = this.parseMeta(this.buildMeta(dto));
    const merged = { ...existingMeta };
    for (const key of Object.keys(patch)) {
      if ((dto as unknown as Record<string, unknown>)[key] !== undefined) {
        merged[key] = patch[key];
      }
    }
    return merged;
  }

  async create(dto: CreateParticipantDto): Promise<ParticipantRecord> {
    const existing = await this.usersRepository.findOne({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const fullName = `${dto.firstName} ${dto.lastName}`.trim();
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = this.usersRepository.create({
      email: dto.email,
      fullName,
      phoneNumber: dto.phone,
      passwordHash,
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth,
      profilePictureUrl: dto.profileImageUrl,
      roles: ['user'],
      bio: this.buildMeta(dto),
      isEmailVerified: false,
      isPhoneVerified: false,
    });

    const savedUser = await this.usersRepository.save(user);
    this.logger.log(`Created participant in database: ${savedUser.email}`);
    return this.mapUserToParticipantRecord(savedUser);
  }

  async findAll(): Promise<ParticipantRecord[]> {
    const users = await this.usersRepository.find({
      where: { roles: In(['user']) },
    });
    return users.map((u) => this.mapUserToParticipantRecord(u));
  }

  async findOne(id: string): Promise<ParticipantRecord> {
    const user = await this.usersRepository.findOne({
      where: { id, roles: In(['user']) },
    });
    if (!user) {
      throw new NotFoundException(`Participant with id ${id} not found`);
    }
    return this.mapUserToParticipantRecord(user);
  }

  async update(
    id: string,
    dto: UpdateParticipantDto,
  ): Promise<ParticipantRecord> {
    const user = await this.usersRepository.findOne({
      where: { id, roles: In(['user']) },
    });
    if (!user) {
      throw new NotFoundException(`Participant with id ${id} not found`);
    }

    // Update simple columns
    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const [curFirst, ...curLast] = (user.fullName || '').split(' ');
      const newFirst = dto.firstName ?? curFirst ?? '';
      const newLast = dto.lastName ?? curLast.join(' ') ?? '';
      user.fullName = `${newFirst} ${newLast}`.trim();
    }
    if (dto.phone !== undefined) user.phoneNumber = dto.phone;
    if (dto.gender !== undefined) user.gender = dto.gender;
    if (dto.dateOfBirth !== undefined) user.dateOfBirth = dto.dateOfBirth;
    if (dto.profileImageUrl !== undefined)
      user.profilePictureUrl = dto.profileImageUrl;
    if (dto.password)
      user.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Merge meta stored in bio — only fields explicitly provided in DTO
    const existingMeta = this.parseMeta(user.bio);

    // #region agent log
    fetch('http://127.0.0.1:7900/ingest/60f87d47-04ee-4c91-8969-d73cd3960c98',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'947f72'},body:JSON.stringify({sessionId:'947f72',runId:'post-fix',hypothesisId:'H4',location:'participant.service.ts:update',message:'participant meta before merge',data:{existingCity:existingMeta['city'],dtoKeys:Object.keys(dto),participantId:id},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const updatedMeta = this.mergeMetaPatch(existingMeta, dto);
    user.bio = JSON.stringify(updatedMeta);

    // #region agent log
    fetch('http://127.0.0.1:7900/ingest/60f87d47-04ee-4c91-8969-d73cd3960c98',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'947f72'},body:JSON.stringify({sessionId:'947f72',runId:'post-fix',hypothesisId:'H4',location:'participant.service.ts:update',message:'participant meta after merge',data:{mergedCity:updatedMeta['city'],mergedPincode:updatedMeta['pincode'],participantId:id},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const updatedUser = await this.usersRepository.save(user);
    this.logger.log(`Updated participant in database: ${updatedUser.email}`);
    return this.mapUserToParticipantRecord(updatedUser);
  }

  async remove(id: string): Promise<void> {
    const user = await this.usersRepository.findOne({
      where: { id, roles: In(['user']) },
    });
    if (!user) {
      throw new NotFoundException(`Participant with id ${id} not found`);
    }
    await this.usersRepository.softRemove(user);
    this.logger.log(`Soft-deleted participant in database: ${user.email}`);
  }
}
