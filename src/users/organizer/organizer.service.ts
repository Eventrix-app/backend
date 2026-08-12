import { BadRequestException, Injectable, NotFoundException, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import { hashPassword, verifyPassword } from '../../auth/password.util';
import { UpdateOrganizerDto } from './dto/update-organizer.dto';
import { User } from '../../entities/user.entity';
import { Organizer, VerificationLevel } from '../../entities/organizer.entity';
import { Event, EventApprovalStatus, EventStatus } from '../../entities/event.entity';
import { Follow } from '../../entities/follow.entity';
import { UserSession } from '../../entities/user-session.entity';
import { Enrollment } from '../../entities/enrollment.entity';
import { CacheService } from '../../common/cache/cache.service';
import { userMeCacheKey } from '../users.service';
import { NotificationService } from '../../notifications/notification.service';
import { UploadsService } from '../../uploads/uploads.service';
import { UploadPurpose } from '../../uploads/dto/create-signed-url.dto';
import { EmailService } from '../../email/email.service';
import { passwordChangedEmail } from '../../email/templates';
import { SubmitVerificationDto } from './dto/submit-verification.dto';


// Excludes email and internal business terms (commission rate, autoApproveEvents).
// phone is included only for requesters with a confirmed enrollment — see getPublicProfile.
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
  phone?: string;
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
  // null means "platform default applies", NOT 0 — showing 0% would misreport what they are
  // charged, and saving it back would opt them out of the fee for real.
  commissionRate: number | null;
  commissionFlatFee: number | null;
  // Not on the public profile: it belongs on invoices handed to a counterparty, not in a
  // scrapeable registry of organizers' tax numbers.
  gstin?: string;
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
    @InjectRepository(UserSession)
    private readonly sessionsRepository: Repository<UserSession>,
    @InjectRepository(Enrollment)
    private readonly enrollmentsRepository: Repository<Enrollment>,
    private readonly dataSource: DataSource,
    private readonly cache: CacheService,
    private readonly notificationService: NotificationService,
    private readonly uploadsService: UploadsService,
    private readonly emailService: EmailService,
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
      commissionRate: organizer.commissionRate == null ? null : Number(organizer.commissionRate),
      commissionFlatFee: organizer.commissionFlatFee == null ? null : Number(organizer.commissionFlatFee),
      gstin: organizer.gstin || undefined,
      isActive: !user.deletedAt,
      isBanned: user.isBanned,
      bannedReason: user.bannedReason || undefined,
      createdAt: organizer.createdAt.toISOString(),
      updatedAt: organizer.updatedAt.toISOString(),
    };
  }

  // The deletedAt filter must be a join condition, not a post-fetch filter — paginating over
  // the unfiltered set shorts pages and makes `total` wrong.
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
    let passwordChanged = false;
    if (dto.password) {
      // Requires the current password, same as ParticipantService.update — stops a stolen
      // token taking over the account via a profile update.
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

    if (dto.companyLogoUrl !== undefined) {
      if (dto.companyLogoUrl) {
        this.uploadsService.assertPublicUrlMatchesPurpose(dto.companyLogoUrl, UploadPurpose.COMPANY_LOGO);
      }
      organizer.companyLogoUrl = dto.companyLogoUrl;
    }
    // Empty string is the explicit "no longer registered" signal and must clear the column;
    // storing '' would print a blank field on every invoice.
    if (dto.gstin !== undefined) organizer.gstin = dto.gstin || undefined;
    if (dto.commissionRate !== undefined) organizer.commissionRate = dto.commissionRate;
    if (dto.commissionFlatFee !== undefined) organizer.commissionFlatFee = dto.commissionFlatFee;
    if (dto.verificationLevel !== undefined) {
      organizer.verificationLevel = dto.verificationLevel;
      // Mirrors approveVerification's role grant — otherwise this generic endpoint could set
      // DOCUMENT_VERIFIED while leaving the user without the 'organizer' role.
      if (dto.verificationLevel === VerificationLevel.DOCUMENT_VERIFIED && !user.roles.includes('organizer')) {
        user.roles = [...user.roles, 'organizer'];
      }
    }
    if (dto.autoApproveEvents !== undefined) organizer.autoApproveEvents = dto.autoApproveEvents;

    const savedUser = await this.usersRepository.save(user);
    const savedOrganizer = await this.organizersRepository.save(organizer);

    this.logger.log(`Updated organizer in database: ${savedUser.email}`);

    if (passwordChanged) {
      await this.sessionsRepository.update({ userId: savedUser.id, revokedAt: IsNull() }, { revokedAt: new Date() });
      const changed = passwordChangedEmail();
      await this.emailService.send(savedUser.email, changed.subject, changed.html);
    }

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

    const [eventCount, followerCount, isFollowing, canSeePhone] = await Promise.all([
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
      requestingUserId
        ? this.enrollmentsRepository.exist({
            where: { userId: requestingUserId, status: 'confirmed', event: { organizerId: id } },
          })
        : Promise.resolve(false),
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
      phone: canSeePhone ? organizer.user.phoneNumber || undefined : undefined,
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

  // Batched rather than N getPublicProfile() calls: that path costs ~5 queries per organizer,
  // so following 100 meant ~500 queries for one screen.
  async getMyFollowing(userId: string): Promise<OrganizerPublicProfile[]> {
    const follows = await this.followsRepository.find({ where: { userId }, order: { createdAt: 'DESC' } });
    if (follows.length === 0) return [];

    const organizerIds = follows.map((f) => f.organizerId);

    // A followed organizer can be soft-deleted after the follow was created, since Follow only
    // cascades on hard delete — filter those out here.
    const organizers = await this.organizersRepository.find({
      where: { id: In(organizerIds) },
      relations: ['user'],
    });
    const activeOrganizers = organizers.filter((o) => o.user && !o.user.deletedAt);
    if (activeOrganizers.length === 0) return [];
    const activeIds = activeOrganizers.map((o) => o.id);

    const [eventCountRows, followerCountRows, confirmedOrganizerIdRows] = await Promise.all([
      this.eventsRepository
        .createQueryBuilder('event')
        .select('event.organizerId', 'organizerId')
        .addSelect('COUNT(*)', 'count')
        .where('event.organizerId IN (:...ids)', { ids: activeIds })
        .andWhere('event.approvalStatus = :approvalStatus', { approvalStatus: EventApprovalStatus.APPROVED })
        .andWhere('event.status != :cancelled', { cancelled: EventStatus.CANCELLED })
        .andWhere('event.deletedAt IS NULL')
        .groupBy('event.organizerId')
        .getRawMany<{ organizerId: string; count: string }>(),
      this.followsRepository
        .createQueryBuilder('follow')
        .select('follow.organizerId', 'organizerId')
        .addSelect('COUNT(*)', 'count')
        .where('follow.organizerId IN (:...ids)', { ids: activeIds })
        .groupBy('follow.organizerId')
        .getRawMany<{ organizerId: string; count: string }>(),
      // Same "does this user have a confirmed booking with this organizer" check
      // getPublicProfile() does per-organizer, batched across the whole followed set.
      this.enrollmentsRepository
        .createQueryBuilder('enrollment')
        .innerJoin('enrollment.event', 'event')
        .select('DISTINCT event.organizerId', 'organizerId')
        .where('enrollment.userId = :userId', { userId })
        .andWhere('enrollment.status = :status', { status: 'confirmed' })
        .andWhere('event.organizerId IN (:...ids)', { ids: activeIds })
        .getRawMany<{ organizerId: string }>(),
    ]);

    const eventCountByOrganizer = new Map(eventCountRows.map((r) => [r.organizerId, Number(r.count)]));
    const followerCountByOrganizer = new Map(followerCountRows.map((r) => [r.organizerId, Number(r.count)]));
    const canSeePhoneOrganizerIds = new Set(confirmedOrganizerIdRows.map((r) => r.organizerId));

    return activeOrganizers.map((organizer) => ({
      id: organizer.id,
      companyName: organizer.companyName,
      companyDescription: organizer.companyDescription || undefined,
      companyWebsite: organizer.companyWebsite || undefined,
      companyLogoUrl: organizer.companyLogoUrl || undefined,
      verified: organizer.verificationLevel !== VerificationLevel.UNVERIFIED,
      memberSince: organizer.createdAt.toISOString(),
      eventCount: eventCountByOrganizer.get(organizer.id) ?? 0,
      followerCount: followerCountByOrganizer.get(organizer.id) ?? 0,
      // This whole list is, by construction, every organizer `userId` follows.
      isFollowing: true,
      phone: canSeePhoneOrganizerIds.has(organizer.id) ? organizer.user.phoneNumber || undefined : undefined,
    }));
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

  // Creates the profile on first submission or updates it after a rejection. Never touches
  // verificationLevel or roles — only approveVerification() does, after admin review.
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

    void this.notificationService.notifyOrganizerVerificationSubmitted(userId);
    // Admin recipients are resolved inside NotificationService.enqueueForAdmins, shared with
    // the other admin-queue alerts (event approval, refunds, reports).
    void this.notificationService.notifyOrganizerVerificationNewSubmission(
      organizer.fullName,
      organizer.companyName,
    );

    return this.getMyVerificationStatus(userId);
  }

  // Capped rather than paginated: an unbounded admin queue with no page params, and a cap
  // avoids changing the dashboard's plain-array consumption.
  private static readonly MAX_PENDING_VERIFICATIONS_RETURNED = 200;

  async getPendingVerifications(): Promise<PendingVerificationRecord[]> {
    const organizers = await this.organizersRepository.find({
      where: { verificationLevel: VerificationLevel.UNVERIFIED },
      order: { submittedForReviewAt: 'ASC' },
      take: OrganizerService.MAX_PENDING_VERIFICATIONS_RETURNED,
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

  // The stored *Url fields are private-bucket paths, not public URLs, so an admin needs a
  // freshly signed 5-minute read URL to view them.
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

  // Nothing previously checked a submission was actually pending, so an admin could act on
  // one never submitted, or act twice and re-fire duplicate notifications.
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

  // Both paths lock the Organizer row and re-run assertPendingReview AFTER acquiring it —
  // two admins acting concurrently could otherwise both pass, and the last save would win.
  async approveVerification(organizerId: string): Promise<OrganizerRecord> {
    const organizer = await this.dataSource.transaction(async (manager) => {
      // TypeORM's `relations` always emits a LEFT JOIN, and Postgres refuses FOR UPDATE on
      // the nullable side — so an explicit INNER JOIN is what makes the lock work here.
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
      // Belt-and-braces alongside the row lock: a rejected organizer must never be left at
      // DOCUMENT_VERIFIED, or getMyVerificationStatus reports "approved".
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
