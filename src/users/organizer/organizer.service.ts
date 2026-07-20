import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { UpdateOrganizerDto } from './dto/update-organizer.dto';
import { User } from '../../entities/user.entity';
import { Organizer, VerificationLevel } from '../../entities/organizer.entity';
import { Event, EventApprovalStatus } from '../../entities/event.entity';
import { Follow } from '../../entities/follow.entity';

const BCRYPT_ROUNDS = 10;

// Deliberately excludes everything OrganizerRecord carries that a stranger browsing the
// app has no business seeing: email, phone (PII), commissionRate/commissionFlatFee/
// autoApproveEvents (internal business terms). Only what a follow/profile UI needs.
export interface OrganizerPublicProfile {
  id: string;
  companyName: string;
  companyDescription?: string;
  companyLogoUrl?: string;
  verified: boolean;
  eventCount: number;
  followerCount: number;
  isFollowing?: boolean;
}

export interface OrganizerRecord {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  companyName: string;
  companyDescription?: string;
  companyWebsite?: string;
  companyLogoUrl?: string;
  verified: boolean;
  verifiedAt?: Date;
  verificationLevel: VerificationLevel;
  autoApproveEvents: boolean;
  commissionRate: number;
  commissionFlatFee: number;
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
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(Follow)
    private readonly followsRepository: Repository<Follow>,
  ) {}

  private mapToRecord(user: User, organizer: Organizer): OrganizerRecord {
    const [firstName, ...lastNames] = (user.fullName || '').split(' ');
    return {
      id: organizer.id,
      userId: user.id,
      email: user.email,
      firstName: firstName || '',
      lastName: lastNames.join(' ') || '',
      phone: user.phoneNumber || undefined,
      companyName: organizer.companyName,
      companyDescription: organizer.companyDescription || undefined,
      companyWebsite: organizer.companyWebsite || undefined,
      companyLogoUrl: organizer.companyLogoUrl || undefined,
      verified: organizer.verified,
      verifiedAt: organizer.verifiedAt || undefined,
      verificationLevel: organizer.verificationLevel,
      autoApproveEvents: organizer.autoApproveEvents,
      commissionRate: Number(organizer.commissionRate),
      commissionFlatFee: Number(organizer.commissionFlatFee),
      isActive: !user.deletedAt,
      createdAt: organizer.createdAt.toISOString(),
      updatedAt: organizer.updatedAt.toISOString(),
    };
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

    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const [curFirst, ...curLast] = (user.fullName || '').split(' ');
      user.fullName =
        `${dto.firstName ?? curFirst} ${dto.lastName ?? curLast.join(' ')}`.trim();
    }
    if (dto.phone !== undefined) user.phoneNumber = dto.phone;
    if (dto.password) {
      user.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    }

    if (dto.companyLogoUrl !== undefined) organizer.companyLogoUrl = dto.companyLogoUrl;
    if (dto.commissionRate !== undefined) organizer.commissionRate = dto.commissionRate;
    if (dto.commissionFlatFee !== undefined) organizer.commissionFlatFee = dto.commissionFlatFee;
    if (dto.verificationLevel !== undefined) organizer.verificationLevel = dto.verificationLevel;
    if (dto.autoApproveEvents !== undefined) organizer.autoApproveEvents = dto.autoApproveEvents;

    const savedUser = await this.usersRepository.save(user);
    const savedOrganizer = await this.organizersRepository.save(organizer);

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
    await this.usersRepository.softRemove(organizer.user);
    this.logger.log(
      `Soft-deleted organizer user in database: ${organizer.user.email}`,
    );
  }

  // --- Follow feature ---

  private async loadActiveOrganizer(id: string): Promise<Organizer> {
    const organizer = await this.organizersRepository.findOne({ where: { id }, relations: ['user'] });
    if (!organizer || !organizer.user || organizer.user.deletedAt) {
      throw new NotFoundException(`Organizer with id ${id} not found`);
    }
    return organizer;
  }

  async getPublicProfile(id: string, requestingUserId?: string): Promise<OrganizerPublicProfile> {
    const organizer = await this.loadActiveOrganizer(id);

    const [eventCount, followerCount, isFollowing] = await Promise.all([
      this.eventsRepository.count({
        where: { organizerId: id, approvalStatus: EventApprovalStatus.APPROVED, deletedAt: null as any },
      }),
      this.followsRepository.count({ where: { organizerId: id } }),
      requestingUserId
        ? this.followsRepository.exist({ where: { organizerId: id, userId: requestingUserId } })
        : Promise.resolve(undefined),
    ]);

    return {
      id: organizer.id,
      companyName: organizer.companyName,
      companyDescription: organizer.companyDescription || undefined,
      companyLogoUrl: organizer.companyLogoUrl || undefined,
      verified: organizer.verificationLevel !== VerificationLevel.UNVERIFIED,
      eventCount,
      followerCount,
      isFollowing,
    };
  }

  async follow(organizerId: string, userId: string): Promise<void> {
    const organizer = await this.loadActiveOrganizer(organizerId);
    if (organizer.userId === userId) {
      throw new BadRequestException('You cannot follow your own organizer profile');
    }
    const existing = await this.followsRepository.findOne({ where: { userId, organizerId } });
    if (existing) return; // already following — idempotent, mirrors Favorite's addFavorite
    const follow = this.followsRepository.create({ userId, organizerId });
    try {
      await this.followsRepository.save(follow);
    } catch (err: any) {
      if (err?.code !== '23505') throw err; // lost a concurrent double-tap race — fine, already followed
    }
  }

  async unfollow(organizerId: string, userId: string): Promise<void> {
    await this.followsRepository.delete({ userId, organizerId });
  }

  async getMyFollowing(userId: string): Promise<OrganizerPublicProfile[]> {
    const follows = await this.followsRepository.find({ where: { userId }, order: { createdAt: 'DESC' } });
    if (follows.length === 0) return [];
    return Promise.all(follows.map((f) => this.getPublicProfile(f.organizerId, userId)));
  }
}
