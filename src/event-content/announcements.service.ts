import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventAnnouncement } from '../entities/event-announcement.entity';
import { Event } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { assertEventOwnerOrAdmin } from './event-ownership.util';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto/announcement.dto';
import { ChatRealtimeService } from '../chat/chat-realtime.service';
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
    private readonly chatRealtimeService: ChatRealtimeService,
    private readonly notificationService: NotificationService,
  ) {}

  async findAll(eventId: string): Promise<EventAnnouncement[]> {
    return this.announcementsRepository.find({
      where: { eventId },
      relations: ['postedBy'],
      // This is a @Public() endpoint — the full User relation (passwordHash, email,
      // phoneNumber, roles, pushToken, ...) must never be selected here, only what the
      // announcement card actually shows. See SAFE_ORGANIZER_SELECT in events.service.ts
      // for the same pattern/reasoning.
      select: { postedBy: { id: true, fullName: true } },
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
    const withAuthor = await this.announcementsRepository.findOne({
      where: { id: saved.id },
      relations: ['postedBy'],
      select: { postedBy: { id: true, fullName: true } },
    });
    const announcement = withAuthor ?? saved;

    // Live update for anyone with the event's Community tab open right now...
    this.chatRealtimeService.broadcastAnnouncement(eventId, announcement);

    // ...and a push/email for attendees who aren't. Fire-and-forget: an announcement is
    // already persisted and broadcast by this point, so a notification hiccup here must
    // never fail the request (matches NotificationService.enqueue's own never-throw
    // contract for the same reason elsewhere in the app).
    void this.notifyAttendees(eventId, saved.id, dto.title);

    return announcement;
  }

  // Correcting a typo doesn't warrant re-broadcasting/re-notifying every attendee — only
  // brand-new content does (see create() above). Anyone with the tab already open just sees
  // the correction on their next refetch, same as a delete below.
  async update(
    eventId: string,
    announcementId: string,
    dto: UpdateAnnouncementDto,
    userId: string,
    userRoles: string[],
  ): Promise<EventAnnouncement> {
    await assertEventOwnerOrAdmin(this.eventsRepository, eventId, userId, userRoles);
    const announcement = await this.announcementsRepository.findOne({ where: { id: announcementId, eventId } });
    if (!announcement) throw new NotFoundException(`Announcement ${announcementId} not found`);

    Object.assign(announcement, dto);
    const saved = await this.announcementsRepository.save(announcement);
    return (
      (await this.announcementsRepository.findOne({
        where: { id: saved.id },
        relations: ['postedBy'],
        select: { postedBy: { id: true, fullName: true } },
      })) ?? saved
    );
  }

  async remove(eventId: string, announcementId: string, userId: string, userRoles: string[]): Promise<void> {
    await assertEventOwnerOrAdmin(this.eventsRepository, eventId, userId, userRoles);
    const result = await this.announcementsRepository.delete({ id: announcementId, eventId });
    if (result.affected === 0) throw new NotFoundException(`Announcement ${announcementId} not found`);
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
