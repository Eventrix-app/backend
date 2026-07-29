import { ConflictException, Injectable, NotFoundException, Logger, UnauthorizedException } from '@nestjs/common';
import { In, IsNull, Raw } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { hashPassword, verifyPassword } from '../../auth/password.util';
import { JwtService } from '@nestjs/jwt';
import { CreateParticipantDto } from './dto/create-participant.dto';
import { UpdateParticipantDto } from './dto/update-participant.dto';
import { UpdateInterestsDto } from './dto/update-interests.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { UpdateNotificationPrefsDto } from './dto/update-notification-prefs.dto';
import { User } from '../../entities/user.entity';
import { EventCategory } from '../../entities/category.entity';
import { UserSession } from '../../entities/user-session.entity';
import { JwtPayload } from '../../auth/jwt.util';
import { CacheService } from '../../common/cache/cache.service';
import { EmailService } from '../../email/email.service';
import { passwordChangedEmail } from '../../email/templates';
import { userMeCacheKey } from '../users.service';


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
  isBanned: boolean;
  bannedReason?: string;
  createdAt: string;
  updatedAt: string;
  // Only set on create() — POST /participants is functionally a registration endpoint
  // (same as POST /auth/register, just with a richer profile form), so it must log the
  // new account in immediately too, instead of forcing a separate POST /auth/login.
  accessToken?: string;
}

@Injectable()
export class ParticipantService {
  private readonly logger = new Logger(ParticipantService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(EventCategory)
    private readonly categoryRepository: Repository<EventCategory>,
    @InjectRepository(UserSession)
    private readonly sessionsRepository: Repository<UserSession>,
    private readonly jwtService: JwtService,
    private readonly cache: CacheService,
    private readonly emailService: EmailService,
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
      isBanned: user.isBanned,
      bannedReason: user.bannedReason || undefined,
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
    const { hash: passwordHash, version: passwordHashVersion } = await hashPassword(dto.password);

    const user = this.usersRepository.create({
      email: dto.email,
      fullName,
      phoneNumber: dto.phone,
      passwordHash,
      // Must be set explicitly — the column defaults to 1 for pre-existing rows, so omitting
      // it would label this peppered hash as unpeppered and lock the new account out.
      passwordHashVersion,
      gender: dto.gender,
      dateOfBirth: dto.dateOfBirth,
      profilePictureUrl: dto.profileImageUrl,
      roles: ['user'],
      bio: this.buildMeta(dto),
      isEmailVerified: false,
    });

    const savedUser = await this.usersRepository.save(user);
    this.logger.log(`Created participant in database: ${savedUser.email}`);

    const roles = savedUser.roles?.length ? savedUser.roles : ['user'];
    const payload: JwtPayload = {
      id: savedUser.id,
      email: savedUser.email,
      roles,
      full_name: savedUser.fullName || '',
    };

    return {
      ...this.mapUserToParticipantRecord(savedUser),
      accessToken: this.jwtService.sign(payload),
    };
  }

  async findAll(
    page: number = 1,
    limit: number = 50,
  ): Promise<{ participants: ParticipantRecord[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    const [users, total] = await this.usersRepository.findAndCount({
      where: { roles: Raw((alias) => `${alias} @> '["user"]'::jsonb`) },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return {
      participants: users.map((u) => this.mapUserToParticipantRecord(u)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string): Promise<ParticipantRecord> {
    const user = await this.usersRepository.findOne({
      where: { id, roles: Raw((alias) => `${alias} @> '["user"]'::jsonb`) },
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
      where: { id, roles: Raw((alias) => `${alias} @> '["user"]'::jsonb`) },
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
    let passwordChanged = false;
    if (dto.password) {
      // Requires proof of the current password — without this, anyone holding a valid
      // access token (leaked via XSS, a shared device, insecure storage) could silently
      // overwrite the real owner's password via this profile-update endpoint, bypassing
      // the dedicated change-password flow's current-password check entirely.
      if (!dto.currentPassword) {
        throw new UnauthorizedException('Current password is required to set a new password');
      }
      const matches = await verifyPassword(dto.currentPassword, user.passwordHash ?? '', user.passwordHashVersion);
      if (!matches) {
        throw new UnauthorizedException('Current password is incorrect');
      }
      const changed = await hashPassword(dto.password);
      user.passwordHash = changed.hash;
      user.passwordHashVersion = changed.version;
      user.passwordChangedAt = new Date();
      passwordChanged = true;
    }

    // Merge meta stored in bio — only fields explicitly provided in DTO
    const existingMeta = this.parseMeta(user.bio);

    const updatedMeta = this.mergeMetaPatch(existingMeta, dto);
    user.bio = JSON.stringify(updatedMeta);

    const updatedUser = await this.usersRepository.save(user);
    this.logger.log(`Updated participant in database: ${updatedUser.email}`);
    // Writes here land on the same `users` row GET /users/me (UsersService.findMe) reads
    // and caches — bust that cache key too or the caller would see stale data for its TTL.
    await this.cache.del(userMeCacheKey(id));

    if (passwordChanged) {
      // Matches AuthService.changePassword's behavior: a stolen-but-still-valid session
      // must stop working the moment the password changes, and the real owner gets a
      // notice so an unauthorized change doesn't happen silently.
      await this.sessionsRepository.update({ userId: id, revokedAt: IsNull() }, { revokedAt: new Date() });
      const changed = passwordChangedEmail();
      await this.emailService.send(updatedUser.email, changed.subject, changed.html);
    }

    return this.mapUserToParticipantRecord(updatedUser);
  }

  async updateInterests(userId: string, dto: UpdateInterestsDto): Promise<void> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['interests'],
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const categories = dto.categoryIds.length > 0
      ? await this.categoryRepository.findBy(
          dto.categoryIds.map((id) => ({ id })),
        )
      : [];

    user.interests = categories;
    await this.usersRepository.save(user);
    this.logger.log(`Updated interests for user ${userId}: ${dto.categoryIds.join(', ')}`);
  }

  async updateLocation(userId: string, dto: UpdateLocationDto): Promise<void> {
    const result = await this.usersRepository.update(userId, {
      latitude: dto.latitude,
      longitude: dto.longitude,
    });
    if (result.affected === 0) throw new NotFoundException(`User ${userId} not found`);
    this.logger.log(`Updated location for user ${userId}: ${dto.latitude},${dto.longitude}`);
  }

  async updateNotificationPrefs(userId: string, dto: UpdateNotificationPrefsDto): Promise<void> {
    const result = await this.usersRepository.update(userId, {
      notificationPrefs: dto,
    });
    if (result.affected === 0) throw new NotFoundException(`User ${userId} not found`);
    this.logger.log(`Updated notification prefs for user ${userId}`);
  }

  async remove(id: string): Promise<void> {
    const user = await this.usersRepository.findOne({
      where: { id, roles: Raw((alias) => `${alias} @> '["user"]'::jsonb`) },
    });
    if (!user) {
      throw new NotFoundException(`Participant with id ${id} not found`);
    }
    await this.usersRepository.softRemove(user);
    this.logger.log(`Soft-deleted participant in database: ${user.email}`);
    await this.cache.del(userMeCacheKey(id));
  }
}
