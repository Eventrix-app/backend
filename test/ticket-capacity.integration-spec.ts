import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import configuration from '../src/config/configuration';
import { validateEnv } from '../src/config/env.validation';
import { DatabaseModule } from '../src/database/database.module';
import { AuditLogModule } from '../src/common/audit-log/audit-log.module';
import { NotificationModule } from '../src/notifications/notification.module';
import { EventsModule } from '../src/events/events.module';
import { EventsService } from '../src/events/events.service';
import { User } from '../src/entities/user.entity';
import { Organizer } from '../src/entities/organizer.entity';
import { EventCategory } from '../src/entities/category.entity';
import { Event, EventApprovalStatus, EventStatus } from '../src/entities/event.entity';
import { TicketType } from '../src/entities/ticket-type.entity';
import { Enrollment } from '../src/entities/enrollment.entity';
import { WaitlistEntry } from '../src/entities/waitlist-entry.entity';
import { WaitlistEntryWithPosition } from '../src/waitlist/waitlist.service';

const MARKER = `__phase0_test__${Date.now()}`;
const CAPACITY = 5;
const CONCURRENT_REQUESTS = 20;

describe('Ticket capacity oversell protection (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let eventsService: EventsService;

  let userIds: string[] = [];
  let organizerUserId: string;
  let organizerId: string;
  let categoryId: string;
  let eventId: string;
  let ticketTypeId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
        DatabaseModule,
        AuditLogModule,
        NotificationModule,
        EventsModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    eventsService = moduleRef.get(EventsService);

    const userRepo = dataSource.getRepository(User);
    const organizerRepo = dataSource.getRepository(Organizer);
    const categoryRepo = dataSource.getRepository(EventCategory);
    const eventRepo = dataSource.getRepository(Event);
    const ticketTypeRepo = dataSource.getRepository(TicketType);

    const organizerUser = await userRepo.save(
      userRepo.create({ email: `${MARKER}_organizer@example.com`, fullName: 'Phase0 Test Organizer' }),
    );
    organizerUserId = organizerUser.id;
    const organizer = await organizerRepo.save(
      organizerRepo.create({ userId: organizerUser.id, companyName: MARKER }),
    );
    organizerId = organizer.id;

    const category = await categoryRepo.save(categoryRepo.create({ name: MARKER }));
    categoryId = category.id;

    const event = await eventRepo.save(
      eventRepo.create({
        organizerId,
        createdByUserId: organizerUser.id,
        title: MARKER,
        categoryId,
        venueName: 'Test Venue',
        venueAddress: 'Test Address',
        eventDate: '2099-12-31',
        startTime: '10:00:00',
        approvalStatus: EventApprovalStatus.APPROVED,
        status: EventStatus.UPCOMING,
        isPaid: true,
      }),
    );
    eventId = event.id;

    const ticketType = await ticketTypeRepo.save(
      ticketTypeRepo.create({
        eventId,
        name: 'General Admission',
        price: 100,
        quantityTotal: CAPACITY,
        quantitySold: 0,
      }),
    );
    ticketTypeId = ticketType.id;

    const users = await userRepo.save(
      Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
        userRepo.create({ email: `${MARKER}_user${i}@example.com`, fullName: `Phase0 Test User ${i}` }),
      ),
    );
    userIds = users.map((u) => u.id);
  }, 30000);

  afterAll(async () => {
    // Clean up in FK-safe order so a partial failure never leaves orphaned rows behind.
    const enrollmentRepo = dataSource.getRepository(Enrollment);
    const waitlistRepo = dataSource.getRepository(WaitlistEntry);
    const ticketTypeRepo = dataSource.getRepository(TicketType);
    const eventRepo = dataSource.getRepository(Event);
    const organizerRepo = dataSource.getRepository(Organizer);
    const categoryRepo = dataSource.getRepository(EventCategory);
    const userRepo = dataSource.getRepository(User);

    if (eventId) {
      await waitlistRepo.delete({ eventId });
      await enrollmentRepo.delete({ eventId });
      await ticketTypeRepo.delete({ eventId });
      await eventRepo.delete({ id: eventId });
    }
    if (organizerId) await organizerRepo.delete({ id: organizerId });
    if (categoryId) await categoryRepo.delete({ id: categoryId });
    if (userIds.length) await userRepo.delete(userIds);
    if (organizerUserId) await userRepo.delete({ id: organizerUserId });

    await moduleRef.close();
  }, 30000);

  it(`confirms exactly ${CAPACITY} of ${CONCURRENT_REQUESTS} concurrent enrollments and waitlists the rest`, async () => {
    const results = await Promise.allSettled(
      userIds.map((userId) => eventsService.enroll(eventId, userId, ticketTypeId, 1)),
    );

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(0);

    const fulfilledValues = results
      .filter((r): r is PromiseFulfilledResult<Enrollment | WaitlistEntryWithPosition> => r.status === 'fulfilled')
      .map((r) => r.value);

    const confirmed = fulfilledValues.filter((v): v is Enrollment => v instanceof Enrollment);
    const waitlisted = fulfilledValues.filter((v): v is WaitlistEntryWithPosition => v instanceof WaitlistEntry);

    // Oversell protection invariant carries over unchanged from Phase 0: exactly
    // `capacity` requests are confirmed. Phase 1 adds a waitlist landing spot for the
    // rest instead of an outright rejection.
    expect(confirmed).toHaveLength(CAPACITY);
    expect(waitlisted).toHaveLength(CONCURRENT_REQUESTS - CAPACITY);

    const ticketType = await dataSource.getRepository(TicketType).findOneOrFail({ where: { id: ticketTypeId } });
    expect(ticketType.quantitySold).toBe(CAPACITY);
  }, 30000);
});
