import { BadRequestException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { UpdateOrganizerDto } from './dto/update-organizer.dto';
import { User } from '../../entities/user.entity';
import { Organizer, VerificationLevel } from '../../entities/organizer.entity';
import { Event, EventApprovalStatus, EventStatus } from '../../entities/event.entity';
import { Follow } from '../../entities/follow.entity';
import { CacheService } from '../../common/cache/cache.service';
import { userMeCacheKey } from '../users.service';
import { NotificationService } from '../../notifications/notification.service';
import { UploadsService } from '../../uploads/uploads.service';
import { SubmitVerificationDto } from './dto/submit-verification.dto';

const BCRYPT_ROUNDS = 10;

// Deliberately excludes everything OrganizerRecord carries that a stranger browsing the
// app has no business seeing: email, phone (PII), commissionRate/commissionFlatFee/
// autoApproveEvents (internal business terms). Only what a follow/profile UI needs.
export interface OrganizerPublicProfile {
  id: string;
  companyName: string;
  companyDescription?: string;
  companyWebsite?: string;
  companyLogoUrl?: string;
  verified: boolean;
  memberSince: string;
  eventCount: number;
  followerCount: number;
  isFollowing?: boolean;
}

// What the applicant sees of their own submission — never exposes the raw document paths
// (those only matter to admin review, via getVerificationDocuments's signed read URLs).
export interface VerificationStatusRecord {
  status: 'not_submitted' | 'pending' | 'approved' | 'rejected';
  verificationLevel: VerificationLevel;
  submittedForReviewAt?: string;
  rejectionReason?: string;
}

// Admin-only queue entry — includes just enough identity to review, not the full
// OrganizerRecord (no commission/auto-approve fields, which are unrelated to KYC).
export interface PendingVerificationRecord {
  id: string;
  userId: string;
  fullName?: string;
  companyName: string;
  upiId?: string;
  submittedForReviewAt?: string;
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
  profilePictureUrl?: string;
  verified: boolean;
  verifiedAt?: Date;
  verificationLevel: VerificationLevel;
  autoApproveEvents: boolean;
  commissionRate: number;
  commissionFlatFee: number;
  isActive: boolean;
  isBanned: boolean;
  bannedReason?: string;
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
    private readonly dataSource: DataSource,
    private readonly cache: CacheService,
    private readonly notificationService: NotificationService,
    private readonly uploadsService: UploadsService,
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
      profilePictureUrl: user.profilePictureUrl || undefined,
      verified: organizer.verified,
      verifiedAt: organizer.verifiedAt || undefined,
      verificationLevel: organizer.verificationLevel,
      autoApproveEvents: organizer.autoApproveEvents,
      commissionRate: Number(organizer.commissionRate),
      commissionFlatFee: Number(organizer.commissionFlatFee),
      isActive: !user.deletedAt,
      isBanned: user.isBanned,
      bannedReason: user.bannedReason || undefined,
      createdAt: organizer.createdAt.toISOString(),
      updatedAt: organizer.updatedAt.toISOString(),
    };
  }

  // Paginated (admin dashboard's People page listing) — the `user.deletedAt IS NULL`
  // filter has to be a query-level join condition, not a post-fetch JS filter (as this
  // used to be), because paginating with skip/take over the unfiltered set would otherwise
  // both short a page of otherwise-active organizers and make `total` wrong.
  async findAll(
    page: number = 1,
    limit: number = 50,
  ): Promise<{ organizers: OrganizerRecord[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    const [rows, total] = await this.organizersRepository
      .createQueryBuilder('organizer')
      .innerJoinAndSelect('organizer.user', 'user')
      .where('user.deletedAt IS NULL')
      .orderBy('organizer.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      organizers: rows.map((o) => this.mapToRecord(o.user, o)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
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
      user.passwordChangedAt = new Date();
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
        where: {
          organizerId: id,
          approvalStatus: EventApprovalStatus.APPROVED,
          status: Not(EventStatus.CANCELLED),
          deletedAt: null as any,
        },
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
      companyWebsite: organizer.companyWebsite || undefined,
      companyLogoUrl: organizer.companyLogoUrl || undefined,
      verified: organizer.verificationLevel !== VerificationLevel.UNVERIFIED,
      memberSince: organizer.createdAt.toISOString(),
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
    await this.cache.del(userMeCacheKey(userId));

    // Fire-and-forget — a notification hiccup must never fail the follow itself.
    const follower = await this.usersRepository.findOne({ where: { id: userId } });
    void this.notificationService.notifyOrganizerFollowed(
      organizer.userId,
      userId,
      follower?.fullName || follower?.email || 'Someone',
    );
  }

  async unfollow(organizerId: string, userId: string): Promise<void> {
    await this.followsRepository.delete({ userId, organizerId });
    await this.cache.del(userMeCacheKey(userId));
  }

  async getMyFollowing(userId: string): Promise<OrganizerPublicProfile[]> {
    const follows = await this.followsRepository.find({ where: { userId }, order: { createdAt: 'DESC' } });
    if (follows.length === 0) return [];

    // A followed organizer's account can be soft-deleted after the follow was created
    // (Follow rows only cascade-delete on a *hard* delete, which OrganizerService.remove()
    // never does). getPublicProfile() 404s for a deleted organizer, and Promise.all rejects
    // on the first rejection — one stale follow would otherwise take down this whole list.
    // Promise.allSettled + filtering drops just that entry instead.
    const results = await Promise.allSettled(follows.map((f) => this.getPublicProfile(f.organizerId, userId)));
    return results
      .filter((r): r is PromiseFulfilledResult<OrganizerPublicProfile> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  // --- KYC verification (#7) ---

  async getMyVerificationStatus(userId: string): Promise<VerificationStatusRecord> {
    const organizer = await this.organizersRepository.findOne({ where: { userId } });
    if (!organizer) {
      return { status: 'not_submitted', verificationLevel: VerificationLevel.UNVERIFIED };
    }
    if (organizer.verificationLevel === VerificationLevel.DOCUMENT_VERIFIED) {
      return { status: 'approved', verificationLevel: organizer.verificationLevel };
    }
    if (organizer.rejectionReason) {
      return {
        status: 'rejected',
        verificationLevel: organizer.verificationLevel,
        rejectionReason: organizer.rejectionReason,
      };
    }
    if (organizer.submittedForReviewAt) {
      return {
        status: 'pending',
        verificationLevel: organizer.verificationLevel,
        submittedForReviewAt: organizer.submittedForReviewAt.toISOString(),
      };
    }
    return { status: 'not_submitted', verificationLevel: organizer.verificationLevel };
  }

  // Creates the Organizer profile on first submission (replacing the old auto-create in
  // EventsService.createForUser, which granted the role with no check at all) or updates it
  // on resubmission after a rejection. Never touches verificationLevel or the user's roles
  // itself — only approveVerification() does that, after an admin actually reviews it.
  async submitVerification(userId: string, dto: SubmitVerificationDto): Promise<VerificationStatusRecord> {
    let organizer = await this.organizersRepository.findOne({ where: { userId } });
    if (!organizer) {
      organizer = this.organizersRepository.create({ userId, companyName: dto.companyName });
    }
    if (organizer.verificationLevel === VerificationLevel.DOCUMENT_VERIFIED) {
      throw new BadRequestException('This organizer is already verified.');
    }

    organizer.fullName = dto.fullName;
    organizer.companyName = dto.companyName;
    organizer.identityProofUrl = dto.identityProofUrl;
    organizer.addressProofUrl = dto.addressProofUrl;
    organizer.panOrAadhaarUrl = dto.panOrAadhaarUrl;
    organizer.upiId = dto.upiId;
    organizer.submittedForReviewAt = new Date();
    organizer.rejectionReason = null as unknown as string;

    await this.organizersRepository.save(organizer);
    this.logger.log(`Organizer verification submitted for review: user ${userId}`);
    return this.getMyVerificationStatus(userId);
  }

  async getPendingVerifications(): Promise<PendingVerificationRecord[]> {
    const organizers = await this.organizersRepository.find({
      where: { verificationLevel: VerificationLevel.UNVERIFIED },
      order: { submittedForReviewAt: 'ASC' },
    });
    return organizers
      .filter((o) => o.submittedForReviewAt != null)
      .map((o) => ({
        id: o.id,
        userId: o.userId,
        fullName: o.fullName || undefined,
        companyName: o.companyName,
        upiId: o.upiId || undefined,
        submittedForReviewAt: o.submittedForReviewAt?.toISOString(),
      }));
  }

  // Mints fresh 5-minute signed read URLs for a submission's three documents — the stored
  // *Url fields are actually private-bucket storage paths (see UploadsService.isPrivate),
  // never real public URLs, so an admin needs one of these to actually view them.
  async getVerificationDocuments(organizerId: string): Promise<Record<string, string>> {
    const organizer = await this.loadActiveOrganizer(organizerId);
    if (!organizer.identityProofUrl || !organizer.addressProofUrl || !organizer.panOrAadhaarUrl) {
      throw new NotFoundException('This organizer has not submitted verification documents.');
    }
    const [identityProofUrl, addressProofUrl, panOrAadhaarUrl] = await Promise.all([
      this.uploadsService.createSignedReadUrl(organizer.identityProofUrl),
      this.uploadsService.createSignedReadUrl(organizer.addressProofUrl),
      this.uploadsService.createSignedReadUrl(organizer.panOrAadhaarUrl),
    ]);
    return { identityProofUrl, addressProofUrl, panOrAadhaarUrl };
  }

  // Neither loadActiveOrganizer nor either caller previously checked that a submission
  // was actually pending review — an admin could approve/reject an organizer who never
  // submitted documents (submittedForReviewAt never set), or act a second time on one
  // already approved/rejected (re-granting nothing new but re-firing a duplicate
  // approval/rejection notification each time).
  private assertPendingReview(organizer: Organizer, action: 'approve' | 'reject'): void {
    const isPending =
      organizer.submittedForReviewAt != null &&
      organizer.verificationLevel !== VerificationLevel.DOCUMENT_VERIFIED &&
      !organizer.rejectionReason;
    if (!isPending) {
      throw new BadRequestException(
        `Cannot ${action} verification for organizer ${organizer.id}: no submission is currently pending review.`,
      );
    }
  }

  // Both approve and reject take a pessimistic_write lock on the same Organizer row and
  // re-run assertPendingReview() *after* acquiring it — without this, two admins acting on
  // the same submission concurrently (one approve, one reject) could both pass the pending
  // check before either commits, and whichever save() landed last would silently win,
  // potentially leaving a rejected organizer with the 'organizer' role still granted (or a
  // duplicate approval notification). The lock serializes the two transactions, so the
  // second one to run sees the first one's already-applied state and correctly gets
  // rejected by assertPendingReview instead of racing it.
  async approveVerification(organizerId: string): Promise<OrganizerRecord> {
    const organizer = await this.dataSource.transaction(async (manager) => {
      // Postgres refuses `FOR UPDATE` on the nullable side of an outer join, and TypeORM's
      // find()/findOne() `relations` option always generates a LEFT JOIN regardless of the
      // relation's own nullability — combined with `lock`, that 500s every single time
      // ("FOR UPDATE cannot be applied to the nullable side of an outer join"). Organizer.user
      // is a required (non-nullable) relation, so an explicit INNER JOIN via query builder is
      // both correct and lock-compatible.
      const organizer = await manager
        .createQueryBuilder(Organizer, 'organizer')
        .innerJoinAndSelect('organizer.user', 'user')
        .where('organizer.id = :id', { id: organizerId })
        .setLock('pessimistic_write')
        .getOne();
      if (!organizer || !organizer.user || organizer.user.deletedAt) {
        throw new NotFoundException(`Organizer with id ${organizerId} not found`);
      }
      this.assertPendingReview(organizer, 'approve');

      organizer.verificationLevel = VerificationLevel.DOCUMENT_VERIFIED;
      organizer.verified = true;
      organizer.verifiedAt = new Date();
      organizer.rejectionReason = null as unknown as string;
      await manager.save(organizer);

      if (!organizer.user.roles.includes('organizer')) {
        organizer.user.roles = [...organizer.user.roles, 'organizer'];
        await manager.save(organizer.user);
      }
      return organizer;
    });

    await this.cache.del(userMeCacheKey(organizer.userId));
    this.logger.log(`Organizer ${organizerId} verification approved — 'organizer' role granted`);
    void this.notificationService.notifyOrganizerVerificationApproved(organizer.userId);
    return this.mapToRecord(organizer.user, organizer);
  }

  async rejectVerification(organizerId: string, reason: string): Promise<OrganizerRecord> {
    const organizer = await this.dataSource.transaction(async (manager) => {
      // See identical comment in approveVerification() above — same lock/outer-join fix.
      const organizer = await manager
        .createQueryBuilder(Organizer, 'organizer')
        .innerJoinAndSelect('organizer.user', 'user')
        .where('organizer.id = :id', { id: organizerId })
        .setLock('pessimistic_write')
        .getOne();
      if (!organizer || !organizer.user || organizer.user.deletedAt) {
        throw new NotFoundException(`Organizer with id ${organizerId} not found`);
      }
      this.assertPendingReview(organizer, 'reject');

      organizer.rejectionReason = reason;
      organizer.submittedForReviewAt = null as unknown as Date;
      // Belt-and-suspenders alongside the row lock above: a rejected organizer must never
      // be left at DOCUMENT_VERIFIED/verified, so getMyVerificationStatus() can't report
      // "approved" for a submission an admin just rejected.
      organizer.verificationLevel = VerificationLevel.UNVERIFIED;
      organizer.verified = false;
      await manager.save(organizer);
      return organizer;
    });

    this.logger.log(`Organizer ${organizerId} verification rejected: ${reason}`);
    void this.notificationService.notifyOrganizerVerificationRejected(organizer.userId, reason);
    return this.mapToRecord(organizer.user, organizer);
  }
}
