import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventAnnouncement } from '../entities/event-announcement.entity';
import { Event } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { assertEventOwnerOrAdmin } from './event-ownership.util';
import { CreateAnnouncementDto } from './dto/announcement.dto';
import { ChatGateway } from '../chat/chat.gateway';
import { NotificationService } from '../notifications/notification.service';

@Injectable()
export class AnnouncementsService {
  constructor(
    @InjectRepository(EventAnnouncement)
    private readonly announcementsRepository: Repository<EventAnnouncement>,
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(Enrollment)
    private readonly enrollmentsRepository: Repository<Enrollment>,
    private readonly chatGateway: ChatGateway,
    private readonly notificationService: NotificationService,
  ) {}

  async findAll(eventId: string): Promise<EventAnnouncement[]> {
    return this.announcementsRepository.find({
      where: { eventId },
      relations: ['postedBy'],
      order: { createdAt: 'DESC' },
    });
  }

  async create(
    eventId: string,
    dto: CreateAnnouncementDto,
    userId: string,
    userRoles: string[],
  ): Promise<EventAnnouncement> {
    await assertEventOwnerOrAdmin(this.eventsRepository, eventId, userId, userRoles);

    const created = this.announcementsRepository.create({ eventId, postedByUserId: userId, ...dto });
    const saved = await this.announcementsRepository.save(created);
    const withAuthor = await this.announcementsRepository.findOne({ where: { id: saved.id }, relations: ['postedBy'] });
    const announcement = withAuthor ?? saved;

    // Live update for anyone with the event's Community tab open right now...
    this.chatGateway.broadcastAnnouncement(eventId, announcement);

    // ...and a push/email for attendees who aren't. Fire-and-forget: an announcement is
    // already persisted and broadcast by this point, so a notification hiccup here must
    // never fail the request (matches NotificationService.enqueue's own never-throw
    // contract for the same reason elsewhere in the app).
    void this.notifyAttendees(eventId, saved.id, dto.title);

    return announcement;
  }

  private async notifyAttendees(eventId: string, announcementId: string, title: string): Promise<void> {
    const activeEnrollments = await this.enrollmentsRepository.find({
      where: [{ eventId, status: 'confirmed' }, { eventId, status: 'pending' }],
    });
    const userIds = [...new Set(activeEnrollments.map((e) => e.userId))];
    if (userIds.length === 0) return;
    await this.notificationService.notifyAnnouncement(userIds, eventId, announcementId, title);
  }
}
