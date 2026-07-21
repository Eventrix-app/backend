import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Event } from '../entities/event.entity';

// EventsService has an equivalent private isOwnerOrAdmin check it can't expose without
// widening its public surface — this is the same rule (admin, or the event's own
// organizer), reimplemented against a plain Event+organizer lookup so schedule/
// announcements/reviews don't need to depend on the whole EventsModule for one check.
export async function assertEventOwnerOrAdmin(
  eventsRepository: Repository<Event>,
  eventId: string,
  userId: string,
  userRoles: string[],
): Promise<Event> {
  const event = await eventsRepository.findOne({ where: { id: eventId }, relations: ['organizer'] });
  if (!event) throw new NotFoundException(`Event with id ${eventId} not found`);

  const isAdmin = userRoles.includes('admin');
  const isOwner = event.organizer?.userId === userId;
  if (!isAdmin && !isOwner) {
    throw new ForbiddenException('You can only manage content for your own events');
  }
  return event;
}
