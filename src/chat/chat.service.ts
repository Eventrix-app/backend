import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatMessage } from '../entities/chat-message.entity';
import { Event } from '../entities/event.entity';

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

  async assertEventExists(eventId: string): Promise<void> {
    const exists = await this.eventsRepository.exist({ where: { id: eventId, deletedAt: null as any } });
    if (!exists) throw new NotFoundException(`Event with id ${eventId} not found`);
  }

  // Oldest-first for chat UI display; page 1 is the most recent DEFAULT_HISTORY_LIMIT
  // messages, matching the socket's "join room, backfill recent history" flow rather than
  // typical newest-first list pagination.
  async getHistory(eventId: string, page: number = 1, limit: number = ChatService.DEFAULT_HISTORY_LIMIT): Promise<ChatMessageRecord[]> {
    await this.assertEventExists(eventId);
    const skip = (page - 1) * limit;
    const messages = await this.chatMessagesRepository.find({
      where: { eventId },
      relations: ['user'],
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return messages.reverse().map((m) => this.mapToRecord(m));
  }

  async createMessage(eventId: string, userId: string, message: string): Promise<ChatMessageRecord> {
    await this.assertEventExists(eventId);
    const created = this.chatMessagesRepository.create({ eventId, userId, message: message.trim() });
    const saved = await this.chatMessagesRepository.save(created);
    const withUser = await this.chatMessagesRepository.findOne({ where: { id: saved.id }, relations: ['user'] });
    return this.mapToRecord(withUser ?? saved);
  }
}
