import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { ChatMessage } from '../entities/chat-message.entity';
import { Event } from '../entities/event.entity';
import { Enrollment } from '../entities/enrollment.entity';
import { EventsService } from '../events/events.service';
import { BlocksService } from '../moderation/blocks.service';

export interface ChatMessageRecord {
  id: string;
  eventId: string;
  userId: string;
  message: string;
  createdAt: Date;
  user?: { id: string; fullName: string; profilePictureUrl?: string | null };
}

@Injectable()
export class ChatService {
  private static readonly DEFAULT_HISTORY_LIMIT = 50;

  constructor(
    @InjectRepository(ChatMessage)
    private readonly chatMessagesRepository: Repository<ChatMessage>,
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
    @InjectRepository(Enrollment)
    private readonly enrollmentsRepository: Repository<Enrollment>,
    private readonly eventsService: EventsService,
    private readonly blocksService: BlocksService,
  ) {}

  private mapToRecord(message: ChatMessage): ChatMessageRecord {
    return {
      id: message.id,
      eventId: message.eventId,
      userId: message.userId,
      message: message.message,
      createdAt: message.createdAt,
      user: message.user
        ? { id: message.user.id, fullName: message.user.fullName, profilePictureUrl: message.user.profilePictureUrl }
        : undefined,
    };
  }

  // Delegates to the same "hidden pending/rejected event" rule EventsService already
  // enforces on every other read path (GET /:id, ticket types, reviews) — a non-owner,
  // non-admin viewer gets the identical 404 a not-yet-approved event gives everywhere
  // else, instead of chat being the one place that only checked the event existed at all.
  async assertEventVisible(eventId: string, userId?: string, userRoles: string[] = []): Promise<void> {
    await this.eventsService.findOneForViewer(eventId, userId, userRoles);
  }

  // Chat is scoped to people with an actual stake in the event — the organizer who owns it,
  // an admin, or someone with a confirmed enrollment — not just "any signed-in user who can
  // see the event exists" (the bar assertEventVisible alone enforces). Reuses the same
  // "confirmed enrollment" bar ReviewsService already applies to posting a review: a
  // pending/unpaid booking doesn't mean you're actually attending yet.
  private async assertCanAccessChat(eventId: string, userId: string | undefined, userRoles: string[]): Promise<void> {
    if (!userId) {
      throw new ForbiddenException("You must be signed in to access this event's chat");
    }
    if (userRoles.includes('admin')) return;

    const event = await this.eventsRepository.findOne({ where: { id: eventId }, relations: ['organizer'] });
    if (event?.organizer?.userId === userId) return;

    const hasConfirmedEnrollment = await this.enrollmentsRepository.exist({
      where: { eventId, userId, status: 'confirmed' },
    });
    if (!hasConfirmedEnrollment) {
      throw new ForbiddenException("Only confirmed attendees can access this event's chat");
    }
  }

  // Oldest-first for chat UI display; page 1 is the most recent DEFAULT_HISTORY_LIMIT
  // messages, matching the socket's "join room, backfill recent history" flow rather than
  // typical newest-first list pagination.
  //
  // Filtered at the query level (not post-fetch) so blocking still returns a full page —
  // filtering after the fact would silently under-fill a page whenever a blocked user had
  // posted recently, with no way to tell "quiet room" from "someone I blocked was chatty."
  // Real-time messages pushed via ChatRealtimeService's broadcast are NOT filtered by block
  // yet — this only covers the history backfill a client loads on opening the room.
  async getHistory(
    eventId: string,
    userId: string | undefined,
    userRoles: string[],
    page: number = 1,
    limit: number = ChatService.DEFAULT_HISTORY_LIMIT,
  ): Promise<ChatMessageRecord[]> {
    await this.assertEventVisible(eventId, userId, userRoles);
    await this.assertCanAccessChat(eventId, userId, userRoles);
    const skip = (page - 1) * limit;
    const blockedUserIds = userId ? await this.blocksService.getBlockedUserIds(userId) : [];
    const messages = await this.chatMessagesRepository.find({
      where: blockedUserIds.length > 0 ? { eventId, userId: Not(In(blockedUserIds)) } : { eventId },
      relations: ['user'],
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return messages.reverse().map((m) => this.mapToRecord(m));
  }

  async createMessage(eventId: string, userId: string, userRoles: string[], message: string): Promise<ChatMessageRecord> {
    await this.assertEventVisible(eventId, userId, userRoles);
    await this.assertCanAccessChat(eventId, userId, userRoles);
    const created = this.chatMessagesRepository.create({ eventId, userId, message: message.trim() });
    const saved = await this.chatMessagesRepository.save(created);
    const withUser = await this.chatMessagesRepository.findOne({ where: { id: saved.id }, relations: ['user'] });
    return this.mapToRecord(withUser ?? saved);
  }
}
