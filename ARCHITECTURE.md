# Eventrix System Architecture

## Complete System Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           EVENTRIX PLATFORM                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                                │
│  ┌─────────────────────┐        ┌──────────────────┐      ┌────────────────┐ │
│  │  React Native App   │        │  NestJS Backend  │      │ Supabase       │ │
│  │  (Frontend)         │◄─────►│  (API Server)    │◄────►│ PostgreSQL     │ │
│  │                     │        │                  │      │                │ │
│  │ • Event Discovery   │        │ • Controllers    │      │ • 16 Tables   │ │
│  │ • Video Feed        │        │ • Services       │      │ • Indexes     │ │
│  │ • Booking Flow      │        │ • Repositories   │      │ • Views       │ │
│  │ • User Profile      │        │                  │      │ • Auth        │ │
│  └─────────────────────┘        └──────────────────┘      └────────────────┘ │
│                                                                                │
│  Redux RTK Query                TypeORM                      PostgreSQL       │
│  State Management               ORM                          Database         │
│                                                                                │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow - Creating an Event Booking

```
┌─────────────┐
│ User selects│
│ event and   │
│ clicks book │
└──────┬──────┘
       │
       ▼
┌─────────────────────────┐
│ React Native App sends  │
│ CreateBookingDto        │
│ {eventId, quantity}     │
└──────┬──────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ NestJS API (bookings.controller)    │
│ POST /api/v1/bookings               │
│ @UseGuards(JwtAuthGuard)            │
└──────┬──────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│ BookingsService.createBooking()      │
│ • Validate event exists              │
│ • Check ticket availability          │
│ • Create EventBooking entity         │
│ • Create Ticket entities (qty times) │
│ • Update event.availableTickets      │
│ • Generate QR codes                  │
│ • Create Payment record              │
└──────┬───────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│ TypeORM saves to database            │
│ • INSERT into event_bookings         │
│ • INSERT into tickets                │
│ • INSERT into payments               │
│ • UPDATE events.available_tickets    │
└──────┬───────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│ Return BookingResponseDto            │
│ {booking id, reference, tickets}     │
└──────┬───────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│ Frontend displays confirmation       │
│ Shows QR codes for tickets           │
└──────────────────────────────────────┘
```

---

## Entity Relationship Diagram (ERD)

```
┌──────────────────┐
│     USERS        │
├──────────────────┤
│ id (PK)          │
│ email            │
│ full_name        │
│ phone_number     │
│ password_hash    │
│ profile_picture  │
│ bio              │
│ location         │
│ latitude         │
│ longitude        │
│ date_of_birth    │
│ gender           │
│ role             │
│ is_verified      │
│ created_at       │
│ updated_at       │
│ deleted_at       │
└────────┬─────────┘
         │
    ┌────┴────────────────────┬──────────┬──────────┬──────────┬────────────┐
    │                         │          │          │          │            │
    │ 1:N                     │ 1:N      │ 1:N      │ 1:N      │ 1:N        │
    ▼                         ▼          ▼          ▼          ▼            ▼
┌─────────────────┐   ┌──────────────┐ ┌─────────┐ ┌────────┐ ┌──────────┐ ┌──────┐
│ USER_INTERESTS  │   │ ORGANIZERS   │ │ BOOKINGS│ │REVIEWS │ │ SHORTS   │ │NOTIF │
├─────────────────┤   ├──────────────┤ ├─────────┤ ├────────┤ ├──────────┤ ├──────┤
│ id              │   │ id           │ │ id      │ │ id     │ │ id       │ │ id   │
│ user_id (FK)    │   │ user_id (FK) │ │ user_id │ │user_id │ │creator_id│ │user_ │
│ category_name   │   │ company_name │ │event_id │ │event_id
│ interest_level  │   │ website      │ │ booking │ │ rating │ │video_url │ │type  │
│ created_at      │   │ logo_url     │ │ tickets │ │ title  │ │duration  │ │title │
└─────────────────┘   │ verified     │ │ total   │ │ text   │ │tags      │ │read  │
                      │ created_at   │ │ price   │ │helpful │ │view_count│ │created_at
                      └──────┬───────┘ │ status  │ │created │ │status    │ └──────┘
                             │         │ created │ │updated │ │created   │
                             │ 1:N     │_at      │ │_at     │ │_at       │
                             │         └────┬────┘ └────────┘ └──────┬───┘
                             │              │                        │
                             ▼              ▼                        ▼
                      ┌──────────────┐  ┌────────┐           ┌───────────────┐
                      │   EVENTS     │  │TICKETS │           │SHORTS_LIKES   │
                      ├──────────────┤  ├────────┤           ├───────────────┤
                      │ id           │  │ id     │           │ id            │
                      │ organizer_id │  │booking │           │ user_id (FK)  │
                      │ category_id  │  │ ticket │           │ short_id (FK) │
                      │ title        │  │ qr_code│           │ created_at    │
                      │ venue_name   │  │ status │           └───────────────┘
                      │ venue_addr   │  │created │
                      │ event_date   │  │_at     │           ┌───────────────┐
                      │ start_time   │  └────────┘           │SHORTS_COMMENTS│
                      │ price        │                       ├───────────────┤
                      │ capacity     │  ┌────────────┐       │ id            │
                      │ available    │  │ PAYMENTS   │       │ short_id (FK) │
                      │ featured     │  ├────────────┤       │ user_id (FK)  │
                      │ status       │  │ id         │       │ comment_text  │
                      │ created_at   │  │ booking_id │       │ likes_count   │
                      │ updated_at   │  │ user_id    │       │ created_at    │
                      │ deleted_at   │  │ amount     │       └───────────────┘
                      └──────────────┘  │ transaction
                             ▲          │ status     ┌──────────────────┐
                             │          │ created_at │SHORTS_BOOKMARKS  │
                             │          └────────────┤ id               │
                    ┌────────┴───────┐               │ user_id (FK)     │
                    │ 1:N            │               │ short_id (FK)    │
                    │                │               │ created_at       │
          ┌─────────────────────┐    │               └──────────────────┘
          │EVENT_CATEGORIES     │    │
          ├─────────────────────┤    │
          │ id                  │    │
          │ name                │    │
          │ emoji               │    │
          │ color_hex           │    │
          │ description         │    │
          └─────────────────────┘    │
                    ▲                │
                    │ N:1            │
          ┌─────────────────┐        │
          │USER_SAVED_EVENTS│        │
          ├─────────────────┤        │
          │ id              │        │
          │ user_id (FK)────┤────────┘
          │ event_id (FK)───┤────────┐
          │ saved_at        │        │
          └─────────────────┘        │
                                     │
                    ┌────────────────┘
                    ▼
          ┌──────────────────┐
          │USER_FOLLOWERS    │
          ├──────────────────┤
          │ id               │
          │ follower_id (FK) │
          │ following_id(FK) │
          │ created_at       │
          └──────────────────┘
```

---

## API Request/Response Flow

### Example: Get Events with Filters

**Request:**
```json
GET /api/v1/events?categoryId=abc&fromDate=2026-07-01&toDate=2026-08-31&limit=20&offset=0

Headers:
Authorization: Bearer JWT_TOKEN
Content-Type: application/json
```

**Controller validates FilterEventsDto:**
```typescript
{
  categoryId: string (UUID)
  fromDate: string (ISO date)
  toDate: string (ISO date)
  limit: number (default 20)
  offset: number (default 0)
}
```

**Service executes query:**
```sql
SELECT * FROM events e
LEFT JOIN event_categories ec ON e.category_id = ec.id
WHERE e.category_id = $1
  AND e.event_date BETWEEN $2 AND $3
  AND e.status = 'active'
ORDER BY e.created_at DESC
LIMIT $4 OFFSET $5
```

**Response:**
```json
{
  "events": [
    {
      "id": "uuid",
      "title": "Neon Nights Music Festival",
      "description": "...",
      "venueName": "Phoenix Arena",
      "eventDate": "2026-07-12",
      "pricePerTicket": 499,
      "imageUrl": "...",
      "categoryName": "Music",
      "organizer": {...},
      "averageRating": 4.5,
      "bookingCount": 125
    },
    ...
  ],
  "total": 42
}
```

---

## Database Query Performance Optimization

### Indexes Created
```
users:
  - id (PRIMARY KEY)
  - email (UNIQUE)
  - role

events:
  - id (PRIMARY KEY)
  - organizer_id (Foreign Key) ← Fast lookups for organizer's events
  - category_id (Foreign Key) ← Fast category filtering
  - status ← Fast status filtering
  - featured ← Fast featured events query
  - event_date ← Fast date range queries

event_bookings:
  - id (PRIMARY KEY)
  - user_id ← Fast user's bookings
  - event_id ← Fast event's bookings
  - status ← Fast booking status filtering

user_saved_events:
  - user_id, event_id (UNIQUE combined) ← Prevent duplicates

shorts:
  - id (PRIMARY KEY)
  - creator_id ← Fast creator's shorts
  - status ← Fast status filtering
```

### Common Query Patterns

**Find all events for a category:**
```sql
SELECT * FROM events 
WHERE category_id = $1 AND status = 'active'
```
Uses index on `category_id` and `status` ✓

**Find user's bookings:**
```sql
SELECT * FROM event_bookings 
WHERE user_id = $1
ORDER BY booking_date DESC
```
Uses index on `user_id` ✓

**Check if user saved event:**
```sql
SELECT 1 FROM user_saved_events 
WHERE user_id = $1 AND event_id = $2
```
Uses UNIQUE index on (user_id, event_id) ✓

---

## Security Considerations

### Authentication Flow
```
1. User sends credentials → POST /auth/register
2. Backend hashes password (bcrypt)
3. Stores in users.password_hash
4. On login, verifies password
5. Generates JWT token with user ID
6. Token sent in Authorization header
7. Protected routes check JWT with JwtAuthGuard
```

### Data Protection
```
- password_hash never returned in API responses
- Soft deletes keep data for compliance (deleted_at)
- Foreign keys enforce referential integrity
- Email/phone verified flags track validation
- Role-based access control (user/organizer/admin)
```

### Rate Limiting (To Implement)
```
- Apply to authentication endpoints
- Apply to booking endpoints
- Apply to upload endpoints
```

---

## Scalability Considerations

### Current Design Supports:
- ✓ Millions of users
- ✓ Thousands of events
- ✓ Real-time updates (via Supabase Realtime)
- ✓ Video uploads (stored in Supabase Storage)
- ✓ Full-text search (PostgreSQL FTS)

### Future Optimizations:
- Cache frequently accessed events (Redis)
- Materialized views for leaderboards
- Event streaming for real-time updates
- CDN for image/video delivery
- Database read replicas for scaling reads

---

## Module Dependencies

```
app.module.ts (root)
│
├── AuthModule (no deps - foundation)
│   └── JwtStrategy, JwtAuthGuard
│
├── UsersModule (depends on: Auth)
│   └── UserService, UserInterestService
│
├── EventsModule (depends on: Auth)
│   └── EventsService
│
├── BookingsModule (depends on: Events, Auth, Payments)
│   └── BookingsService
│
├── ReviewsModule (depends on: Events, Auth)
│   └── ReviewsService
│
├── ShortsModule (depends on: Auth, Events)
│   └── ShortsService, ShortsInteractionService
│
├── PaymentsModule (depends on: Bookings)
│   └── PaymentsService, PaymentGatewayService
│
└── NotificationsModule (depends on: Events, Bookings)
    └── NotificationsService
```

---

## Deployment Architecture

```
                    Frontend                        Backend
            ┌─────────────────────┐        ┌──────────────────┐
            │  Vercel (or similar)│        │ Railway/Heroku   │
            │  React Native Build │        │ NestJS Container │
            │  (Expo)             │        │                  │
            └──────────┬──────────┘        └────────┬─────────┘
                       │                           │
                       └─────────┬─────────────────┘
                                 │
                            API Calls
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │   Supabase (Managed)     │
                    │                          │
                    │ ├─ PostgreSQL Database   │
                    │ ├─ Auth Service          │
                    │ ├─ Storage (S3)          │
                    │ └─ Realtime WebSockets   │
                    └──────────────────────────┘
```

---

## Testing Strategy

### Unit Tests (Services)
```typescript
describe('EventsService', () => {
  it('should create event', () => {...})
  it('should filter events by category', () => {...})
  it('should update available tickets', () => {...})
})
```

### Integration Tests (API)
```typescript
describe('Events API', () => {
  it('POST /events should create event', () => {...})
  it('GET /events should return filtered events', () => {...})
})
```

### E2E Tests
```typescript
describe('Booking Flow', () => {
  it('user should be able to book event', () => {...})
  it('tickets should be generated with QR codes', () => {...})
})
```

---

## Summary

This architecture ensures:
- ✓ **Scalability** - Proper indexing and normalized schema
- ✓ **Type Safety** - Full TypeScript throughout
- ✓ **Security** - JWT auth, role-based access
- ✓ **Performance** - Optimized queries and caching ready
- ✓ **Maintainability** - Modular structure with clear separation
- ✓ **Extensibility** - Easy to add new features

All files are prepared and ready for implementation!
