import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventScheduleItem } from '../entities/event-schedule.entity';
import { Event } from '../entities/event.entity';
import { assertEventOwnerOrAdmin } from './event-ownership.util';
import { CreateScheduleItemDto, UpdateScheduleItemDto } from './dto/schedule-item.dto';

@Injectable()
export class ScheduleService {
  constructor(
    @InjectRepository(EventScheduleItem)
    private readonly scheduleRepository: Repository<EventScheduleItem>,
    @InjectRepository(Event)
    private readonly eventsRepository: Repository<Event>,
  ) {}

  async findAll(eventId: string): Promise<EventScheduleItem[]> {
    return this.scheduleRepository.find({ where: { eventId }, order: { order: 'ASC' } });
  }

  async create(eventId: string, dto: CreateScheduleItemDto, userId: string, userRoles: string[]): Promise<EventScheduleItem> {
    await assertEventOwnerOrAdmin(this.eventsRepository, eventId, userId, userRoles);
    const item = this.scheduleRepository.create({ eventId, ...dto });
    return this.scheduleRepository.save(item);
  }

  async update(
    eventId: string,
    itemId: string,
    dto: UpdateScheduleItemDto,
    userId: string,
    userRoles: string[],
  ): Promise<EventScheduleItem> {
    await assertEventOwnerOrAdmin(this.eventsRepository, eventId, userId, userRoles);
    const item = await this.scheduleRepository.findOne({ where: { id: itemId, eventId } });
    if (!item) throw new NotFoundException(`Schedule item ${itemId} not found`);
    Object.assign(item, dto);
    return this.scheduleRepository.save(item);
  }

  async remove(eventId: string, itemId: string, userId: string, userRoles: string[]): Promise<void> {
    await assertEventOwnerOrAdmin(this.eventsRepository, eventId, userId, userRoles);
    const result = await this.scheduleRepository.delete({ id: itemId, eventId });
    if (result.affected === 0) throw new NotFoundException(`Schedule item ${itemId} not found`);
  }
}
