import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { WaitlistEntry, WaitlistStatus } from '../entities/waitlist-entry.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { NotificationService } from '../notifications/notification.service';
import { CacheService } from '../common/cache/cache.service';
import { invalidateEventCaches } from '../events/utils/event-cache.util';

export type WaitlistEntryWithPosition = WaitlistEntry & { position: number };

@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    @InjectRepository(WaitlistEntry)
    private readonly waitlistRepository: Repository<WaitlistEntry>,
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly notificationService: NotificationService,
    private readonly cache: CacheService,
  ) {}

  async join(eventId: string, ticketTypeId: string, userId: string, quantity: number): Promise<WaitlistEntryWithPosition> {
    const existing = await this.waitlistRepository.findOne({
      where: { ticketTypeId, userId, status: WaitlistStatus.WAITING },
    });
    if (existing) {
      throw new ConflictException('You are already on the waitlist for this ticket type');
    }

    try {
      const entry = this.waitlistRepository.create({
        eventId,
        ticketTypeId,
        userId,
        quantity,
        status: WaitlistStatus.WAITING,
      });
      const saved = await this.waitlistRepository.save(entry);
      this.logger.log(`User ${userId} joined waitlist for ticket type ${ticketTypeId} (qty ${quantity})`);
      const position = await this.getPosition(saved);
      return Object.assign(saved, { position });
    } catch (err) {
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException('You are already on the waitlist for this ticket type');
      }
      throw err;
    }
  }

  async findMyEntries(userId: string): Promise<WaitlistEntryWithPosition[]> {
    const entries = await this.waitlistRepository.find({
      where: { userId },
      relations: ['event', 'ticketType'],
      order: { createdAt: 'DESC' },
    });
    return Promise.all(
      entries.map(async (entry) => Object.assign(entry, { position: await this.getPosition(entry) })),
    );
  }

  // 1-indexed FIFO position among still-WAITING entries for the same tier. Entries that
  // have already moved on (promoted/expired/cancelled) report position 0 — there's
  // nothing to queue for.
  async getPosition(entry: WaitlistEntry): Promise<number> {
    if (entry.status !== WaitlistStatus.WAITING) return 0;
    const aheadCount = await this.waitlistRepository.count({
      where: {
        ticketTypeId: entry.ticketTypeId,
        status: WaitlistStatus.WAITING,
        createdAt: LessThan(entry.createdAt),
      },
    });
    return aheadCount + 1;
  }

  // Called whenever a slot frees up on a ticket type (cancellation or a processed
  // refund). A single free-up can cover more than one waiting entry (a cancelled
  // enrollment with quantity > 1 frees multiple seats at once), so this keeps walking
  // the FIFO queue and promoting everyone it can fit — it only stops once an entry
  // fails to fit the remaining capacity. That entry (and anyone behind it) is left
  // WAITING (not skipped-forever) so it's retried on the next free-up.
  async promoteNext(ticketTypeId: string): Promise<void> {
    const waitingEntries = await this.waitlistRepository.find({
      where: { ticketTypeId, status: WaitlistStatus.WAITING },
      order: { createdAt: 'ASC' },
    });

    for (const entry of waitingEntries) {
      const promoted = await this.tryPromote(entry);
      if (!promoted) return;
    }
  }

  private async tryPromote(entry: WaitlistEntry): Promise<boolean> {
    const promotedEnrollment = await this.dataSource.transaction(async (manager) => {
      // Re-check under lock — a concurrent promotion pass could have already claimed
      // or expired this entry since the FIFO list was read.
      const fresh = await manager.findOne(WaitlistEntry, {
        where: { id: entry.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!fresh || fresh.status !== WaitlistStatus.WAITING) return null;

      // Same atomic, race-safe capacity claim as the primary enrollment path.
      const updateResult = await manager.query(
        `UPDATE ticket_types
         SET quantity_sold = quantity_sold + $1, updated_at = now()
         WHERE id = $2
           AND (quantity_total IS NULL OR quantity_sold + $1 <= quantity_total)
         RETURNING *`,
        [fresh.quantity, fresh.ticketTypeId],
      );
      if (!updateResult?.[0]?.length) return null;

      const ticketType = updateResult[0][0] as { price: string };
      const bookingReference = `BK-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const totalAmount = Number(ticketType.price) * fresh.quantity;

      const enrollment = manager.create(Enrollment, {
        userId: fresh.userId,
        eventId: fresh.eventId,
        ticketTypeId: fresh.ticketTypeId,
        quantity: fresh.quantity,
        totalAmount,
        status: 'confirmed',
        // Mirrors EventsService.enroll(): free tickets have no gateway/webhook, so mark
        // them settled immediately; paid tickets wait for handleWebhook() confirmation.
        paymentStatus: totalAmount === 0 ? 'paid' : 'pending',
        bookingDate: new Date(),
        bookingReference,
      });
      let saved = await manager.save(Enrollment, enrollment);

      const ticketCode = this.jwtService.sign(
        { enrollmentId: saved.id, eventId: saved.eventId },
        { expiresIn: '365d' },
      );
      saved.ticketCode = ticketCode;
      saved = await manager.save(Enrollment, saved);

      fresh.status = WaitlistStatus.PROMOTED;
      fresh.promotedAt = new Date();
      fresh.promotedEnrollmentId = saved.id;
      await manager.save(WaitlistEntry, fresh);

      this.logger.log(`Waitlist entry ${fresh.id} promoted to enrollment ${saved.id} for user ${fresh.userId}`);
      return saved;
    });

    if (!promotedEnrollment) return false;

    // A promotion consumes a seat exactly like a direct enroll() does — same
    // availableTickets staleness risk if this is skipped.
    await invalidateEventCaches(this.cache, promotedEnrollment.eventId);

    await this.notificationService.notifyWaitlistPromoted(
      promotedEnrollment.userId,
      promotedEnrollment.eventId,
      promotedEnrollment.id,
    );
    return true;
  }
}
