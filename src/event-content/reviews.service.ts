import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventReview } from '../entities/event-review.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { CreateReviewDto } from './dto/review.dto';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectRepository(EventReview)
    private readonly reviewsRepository: Repository<EventReview>,
    @InjectRepository(Enrollment)
    private readonly enrollmentsRepository: Repository<Enrollment>,
  ) {}

  async findAll(eventId: string): Promise<EventReview[]> {
    return this.reviewsRepository.find({
      where: { eventId },
      relations: ['user'],
      // This is a @Public() endpoint — the full User relation (passwordHash, email,
      // phoneNumber, roles, pushToken, ...) must never be selected here, only what the
      // reviewer card actually shows. See SAFE_ORGANIZER_SELECT in events.service.ts for
      // the same pattern/reasoning.
      select: { user: { id: true, fullName: true } },
      order: { createdAt: 'DESC' },
    });
  }

  async create(eventId: string, dto: CreateReviewDto, userId: string): Promise<EventReview> {
    // Restricted to confirmed enrollees — prevents drive-by reviews from people who never
    // attended. "confirmed" specifically (not "pending"): a review implies the event
    // actually happened for this person, which an unconfirmed/unpaid booking doesn't yet.
    const hasConfirmedEnrollment = await this.enrollmentsRepository.exist({
      where: { eventId, userId, status: 'confirmed' },
    });
    if (!hasConfirmedEnrollment) {
      throw new ForbiddenException('Only confirmed attendees can review this event');
    }

    const existing = await this.reviewsRepository.findOne({ where: { eventId, userId } });
    if (existing) {
      throw new ConflictException('You have already reviewed this event');
    }

    const created = this.reviewsRepository.create({ eventId, userId, ...dto });
    const saved = await this.reviewsRepository.save(created);
    return (
      (await this.reviewsRepository.findOne({
        where: { id: saved.id },
        relations: ['user'],
        select: { user: { id: true, fullName: true } },
      })) ?? saved
    );
  }
}
