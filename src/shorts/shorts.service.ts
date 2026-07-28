import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Short, ShortModerationStatus } from '../entities/short.entity';
import { ShortLike } from '../entities/short-like.entity';
import { Event } from '../entities/event.entity';
import { CreateShortDto } from './dto/create-short.dto';

const SAFE_UPLOADER_SELECT = {
  uploader: { id: true, fullName: true, email: true, profilePictureUrl: true },
} as const;

@Injectable()
export class ShortsService {
  constructor(
    @InjectRepository(Short)
    private readonly shortsRepository: Repository<Short>,
    @InjectRepository(ShortLike)
    private readonly shortLikesRepository: Repository<ShortLike>,
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
  ) {}

  async findAllForAdmin(filters: {
    moderationStatus?: ShortModerationStatus;
    page?: number;
    limit?: number;
  }): Promise<{ shorts: Short[]; total: number; page: number; totalPages: number }> {
    const { moderationStatus, page = 1, limit = 20 } = filters;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (moderationStatus) where.moderationStatus = moderationStatus;

    const [shorts, total] = await this.shortsRepository.findAndCount({
      where,
      relations: ['uploader'],
      select: SAFE_UPLOADER_SELECT as any,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return { shorts, total, page, totalPages: Math.ceil(total / limit) };
  }

  // Public reel feed. Newest first, keyset-free offset pagination (the feed is small and
  // browsed from the top; a cursor buys nothing yet).
  //
  // Only PUBLISHED reels are ever returned — `under_review`, `flagged` and `removed` are
  // excluded here rather than filtered client-side, so a removed reel cannot be surfaced by
  // a client that ignores the field. Soft-deleted rows are excluded by TypeORM's default
  // handling of the DeleteDateColumn.
  //
  // The uploader is projected down to display name + avatar. This route is @Public(), so
  // anything selected here is world-readable: emails, phone numbers and roles must never be
  // in this projection. SAFE_UPLOADER_SELECT above still carries `email`, which is fine for
  // the admin queue it was written for but not for this one, hence the separate narrower
  // select below.
  async findFeed(filters: { page?: number; limit?: number }): Promise<{
    shorts: Short[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const page = Math.max(1, filters.page ?? 1);
    // Capped so a client cannot ask for the entire table in one request.
    const limit = Math.min(50, Math.max(1, filters.limit ?? 10));

    const [shorts, total] = await this.shortsRepository.findAndCount({
      where: { moderationStatus: ShortModerationStatus.PUBLISHED },
      relations: ['uploader', 'event'],
      select: {
        uploader: { id: true, fullName: true, profilePictureUrl: true },
        // coverImageUrl so a reel with no generated thumbnail still has an image to show in
        // the Home "Event Highlights" strip. Already public on every event listing, so this
        // exposes nothing new.
        event: { id: true, title: true, coverImageUrl: true },
      } as any,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { shorts, total, page, totalPages: Math.ceil(total / limit) };
  }

  private async findOrFail(id: string): Promise<Short> {
    const short = await this.shortsRepository.findOne({ where: { id } });
    if (!short) throw new NotFoundException(`Short ${id} not found`);
    return short;
  }

  async approve(id: string): Promise<Short> {
    const short = await this.findOrFail(id);
    short.moderationStatus = ShortModerationStatus.PUBLISHED;
    short.flagReason = undefined;
    return this.shortsRepository.save(short);
  }

  async remove(id: string, reason?: string): Promise<Short> {
    const short = await this.findOrFail(id);
    short.moderationStatus = ShortModerationStatus.REMOVED;
    short.flagReason = reason;
    return this.shortsRepository.save(short);
  }

  // Creator-facing: uploads always launch from an event context (see the Reel Upload
  // screen design), so eventId is validated up front rather than trusted as a loose tag.
  // Published immediately — the existing admin queue polices content after the fact,
  // not before, matching how every other user-generated content type in this app works.
  async create(userId: string, dto: CreateShortDto): Promise<Short> {
    const eventExists = await this.eventsRepository.exists({ where: { id: dto.eventId, deletedAt: null as any } });
    if (!eventExists) {
      throw new NotFoundException(`Event ${dto.eventId} not found`);
    }

    const short = this.shortsRepository.create({
      uploaderUserId: userId,
      eventId: dto.eventId,
      mediaUrl: dto.mediaUrl,
      thumbnailUrl: dto.thumbnailUrl,
      caption: dto.caption,
      locationName: dto.locationName,
      latitude: dto.latitude,
      longitude: dto.longitude,
      overlay: dto.overlay,
      moderationStatus: ShortModerationStatus.PUBLISHED,
    });
    return this.shortsRepository.save(short);
  }

  async findMine(userId: string): Promise<Short[]> {
    return this.shortsRepository.find({
      where: { uploaderUserId: userId },
      order: { createdAt: 'DESC' },
    });
  }

  // Uploader only — deliberately no admin bypass here, unlike most other ownership
  // checks in this codebase. Admin removal already has a dedicated, accountable path
  // (remove() above, via PATCH shorts/:id/remove): it's @AuditAction-logged and records
  // a flagReason, and its RLS-visible effect (moderationStatus != 'published') already
  // hides the reel from the direct-read feed just as effectively as a hard delete. A
  // bypass here would let an admin hard-delete anyone's content with zero audit trail
  // and no recorded reason, undermining the moderation queue's own record-keeping.
  async removeOwn(id: string, userId: string): Promise<void> {
    const short = await this.findOrFail(id);
    if (short.uploaderUserId !== userId) {
      throw new ForbiddenException('You can only delete your own reels');
    }
    await this.shortsRepository.remove(short);
  }

  // Race-tolerant: a duplicate like (double-tap, two devices) hits the unique
  // (user_id, short_id) constraint rather than double-incrementing like_count — same
  // 23505-catch pattern as AuthService's social-login race handling.
  async like(id: string, userId: string): Promise<{ liked: boolean; likeCount: number }> {
    await this.findOrFail(id);
    try {
      await this.shortLikesRepository.insert({ userId, shortId: id });
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        const existing = await this.findOrFail(id);
        return { liked: true, likeCount: existing.likeCount };
      }
      throw err;
    }

    const claim = await this.shortsRepository.query(
      `UPDATE shorts SET like_count = like_count + 1 WHERE id = $1 RETURNING like_count`,
      [id],
    );
    return { liked: true, likeCount: claim[0].like_count };
  }

  // Only decrements when a like row was actually deleted — a repeat unlike call (double
  // tap, retried request) must not drive like_count below the true count.
  async unlike(id: string, userId: string): Promise<{ liked: boolean; likeCount: number }> {
    const short = await this.findOrFail(id);
    const result = await this.shortLikesRepository.delete({ userId, shortId: id });
    if (!result.affected) {
      return { liked: false, likeCount: short.likeCount };
    }

    const claim = await this.shortsRepository.query(
      `UPDATE shorts SET like_count = GREATEST(like_count - 1, 0) WHERE id = $1 RETURNING like_count`,
      [id],
    );
    return { liked: false, likeCount: claim[0].like_count };
  }

  // Backs the "which hearts are filled" state for a feed the client fetched directly
  // from Supabase — that read path has no way to know who's asking, so the app merges
  // this authenticated list with the direct-read feed client-side.
  async findMyLikedIds(userId: string): Promise<string[]> {
    const likes = await this.shortLikesRepository.find({ where: { userId }, select: ['shortId'] });
    return likes.map((l) => l.shortId);
  }
}
