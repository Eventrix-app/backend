import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { ChatMessage } from '../entities/chat-message.entity';
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

  // Oldest-first for chat UI display; page 1 is the most recent DEFAULT_HISTORY_LIMIT
  // messages, matching the socket's "join room, backfill recent history" flow rather than
  // typical newest-first list pagination.
  //
  // Filtered at the query level (not post-fetch) so blocking still returns a full page —
  // filtering after the fact would silently under-fill a page whenever a blocked user had
  // posted recently, with no way to tell "quiet room" from "someone I blocked was chatty."
  // Real-time messages pushed over the socket (ChatGateway) are NOT filtered by block yet —
  // this only covers the history backfill a client loads on opening the room.
  async getHistory(
    eventId: string,
    userId: string | undefined,
    userRoles: string[],
    page: number = 1,
    limit: number = ChatService.DEFAULT_HISTORY_LIMIT,
  ): Promise<ChatMessageRecord[]> {
    await this.assertEventVisible(eventId, userId, userRoles);
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
    const created = this.chatMessagesRepository.create({ eventId, userId, message: message.trim() });
    const saved = await this.chatMessagesRepository.save(created);
    const withUser = await this.chatMessagesRepository.findOne({ where: { id: saved.id }, relations: ['user'] });
    return this.mapToRecord(withUser ?? saved);
  }
}
