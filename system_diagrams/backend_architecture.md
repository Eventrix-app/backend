# Backend Architecture Overview (Enhanced)

## Tech Stack
- **Language:** TypeScript/JavaScript  
- **Framework:** NestJS  
- **ORM:** TypeORM (PostgreSQL)  
- **Caching:** Redis (`RedisMemcachedModule`)  
- **Documentation:** Swagger (`SwaggerModule`)  

---

## Entity Models & Core Features

### 1. `User` Entity
| Field | Type | Description |
|-------|------|-------------|
| `id` | `uuid` (PK) | Unique identifier |
| `email` | `varchar` (unique) | Login credential |
| `fullName` | `varchar` (nullable) | Display name |
| `phoneNumber` | `varchar` (nullable) | Contact phone |
| `passwordHash` | `varchar` (nullable) | Hashed password |
| `profilePictureUrl` | `varchar` (nullable) | Avatar URL |
| `bio` | `varchar` (nullable) | Short bio |
| `location` | `varchar` (nullable) | Geographic location |
| `latitude` | `decimal` (nullable) | Geolocation latitude |
| `longitude` | `decimal` (nullable) | Geolocation longitude |
| `dateOfBirth` | `date` (nullable) | Birth date |
| `gender` | `varchar` (nullable) | Self‑identified gender |
| `role` | `varchar` (`'user'|'admin'|'organizer'`) | User type |
| `isEmailVerified` | `boolean` (default `false`) | Email verification flag |
| `isPhoneVerified` | `boolean` (default `false`) | Phone verification flag |
| `createdAt` | `Date` | Creation timestamp |
| `updatedAt` | `Date` | Last update timestamp |
| `deletedAt` | `Date` (nullable) | Soft‑delete timestamp |
| **Relations** | | |
| `organizers` | `Organizer[]` (One‑to‑Many) | Organizer profiles owned by the user |
| `enrolledIn` | `Event[]` (Many‑to‑Many) | Events the user has signed up for |

**Key Behaviors**  
- Role‑based access control (RBAC) via `role` column.  
- Soft‑delete support (`deletedAt`).  
- Automatic timestamp management (`createdAt`, `updatedAt`).  

---

### 2. `Organizer` Entity
| Field | Type | Description |
|-------|------|-------------|
| `id` | `uuid` (PK) | Unique identifier |
| `userId` | `uuid` | FK → `User` (the account that created the organizer profile) |
| `companyName` | `varchar` | Legal/organizational name |
| `companyDescription` | `varchar` (nullable) | Description of the organization |
| `companyWebsite` | `varchar` (nullable) | Web URL |
| `companyLogoUrl` | `varchar` (nullable) | Logo image URL |
| `verified` | `boolean` (default `false`) | Whether the organizer has passed verification |
| `verifiedAt` | `Date` (nullable) | Timestamp of verification |
| **Relations** | | |
| `events` | `Event[]` (One‑to‑Many) | Events organized by this entity |
| `user` | `User` (Many‑to‑One) | Owner user record |

**Key Behaviors**  
- Organizers can create, edit, and delete their own events.  
- Verification workflow (admin‑driven) controls public visibility.  

---

### 3. `EventCategory` Entity
| Field | Type | Description |
|-------|------|-------------|
| `id` | `uuid` (PK) | Unique identifier |
| `name` | `varchar(100)` (unique) | Human‑readable category name |
| `emoji` | `varchar(10)` (nullable) | Optional UI icon |
| `colorHex` | `varchar(7)` (nullable) | Optional UI color |
| `description` | `text` (nullable) | Detailed description |
| **Relations** | | |
| `events` | `Event[]` (One‑to‑Many) | Events belonging to this category |

**Key Behaviors**  
- Enables grouping and filtering of events.  
- Frequently used for search, UI filtering, and recommendation engines.  

---

### 4. `Event` Entity (Core Domain)
| Field | Type | Description |
|-------|------|-------------|
| `id` | `uuid` (PK) | Unique identifier |
| `organizerId` | `uuid` | FK → `Organizer` |
| `categoryId` | `uuid` | FK → `EventCategory` |
| `participants` | `User[]` (Many‑to‑Many) | Users enrolled in the event |
| `approvalStatus` | `EventApprovalStatus` (`'draft'|'pending_approval'|'approved'|'rejected'`) | Workflow status |
| `rejectionReason` | `text` (nullable) | Reason if rejected |
| `createdByUserId` | `uuid` | FK → `User` (who created the draft) |
| `venueName` | `varchar(255)` | Physical or virtual venue |
| `venueAddress` | `text` | Detailed address |
| `latitude` / `longitude` | `decimal` (nullable) | Geolocation for mapping |
| `eventDate` | `date` | Main date of the event |
| `startTime` | `time` | Start time |
| `endTime` | `time` (nullable) | End time |
| `durationMinutes` | `int` (nullable) | Computed from start/end |
| `pricePerTicket` | `decimal(10,2)` (default `0`) | Ticket cost |
| `currency` | `varchar(10)` (default `'INR'`) | Currency type |
| `totalCapacity` | `int` (nullable) | Max attendees |
| `availableTickets` | `int` (nullable) | Tickets still available |
| `featured` | `boolean` (default `false`) | Highlighted event flag |
| `isOnline` | `boolean` (default `false`) | Indicates virtual event |
| `meetingLink` | `text` (nullable) | URL for online events |
| `imageUrl` / `coverImageUrl` | `text` (nullable) | Media assets |
| `ticketSalesOpenDate` / `ticketSalesCloseDate` | `date` (nullable) | Sales window |
| **Lifecycle Hooks** | | |
| `validateAndCalculate()` | — | Auto‑calculates `durationMinutes`, validates URLs, ensures non‑negative capacities, etc. |
| **Status Management** | | |
| `status` | `EventStatus` (`'upcoming'|'ongoing'|'completed'|'cancelled'`) | Current lifecycle stage |
| Helper methods: `isApproved()`, `canEnroll()`, `hasTicketsAvailable()` | — | Business rule enforcement |

**Key Behaviors**  
- Full workflow: **Draft → Pending Approval → Approved → Ongoing → Completed/Cancelled**.  
- Automatic duration calculation from start/end times.  
- Ticket availability tracking via `availableTickets`.  
- Role‑based CRUD restrictions enforced in the service layer.  

---

## API Endpoint Catalog

| HTTP Method | URL Pattern | Controller | Required Role(s) | Description |
|-------------|-------------|------------|------------------|-------------|
| `POST` | `/auth/login` | `AuthController` | **Public** | Authenticate user & return JWT. |
| `POST` | `/participants` | `ParticipantController` | **Public** | Create a participant (user) profile. |
| `GET` | `/participants` | `ParticipantController` | **admin** | List all participants (admin only). |
| `GET` | `/participants/:id` | `ParticipantController` | **admin** & **user** (self) | Retrieve a participant profile. |
| `PATCH` | `/participants/:id` | `ParticipantController` | **admin** & **user** (self) | Update a participant profile. |
| `DELETE` | `/participants/:id` | `ParticipantController` | **admin** & **user** (self) | Delete a participant profile. |
| `GET` | `/events` | `EventsController` | **Public** | List public events (filterable). |
| `POST` | `/events` | `EventsController` | **admin** & **organizer** | Create a new event (draft). |
| `GET` | `/events/pending` | `EventsController` | **admin** | List events awaiting approval. |
| `GET` | `/events/organizer/:organizerId` | `EventsController` | **admin** & **organizer** | Get all events for a specific organizer. |
| `GET` | `/events/:id` | `EventsController` | **Public** | Retrieve a single event (read‑only). |
| `PATCH` | `/events/:id` | `EventsController` | **admin** & **organizer** (owner) | Update an existing event (draft stage). |
| `PATCH` | `/events/:id/approve` | `EventsController` | **admin** | Approve a pending event. |
| `PATCH` | `/events/:id/reject` | `EventsController` | **admin** | Reject a pending event (with reason). |
| `DELETE` | `/events/:id` | `EventsController` | **admin** & **organizer** (owner) | Delete an event. |
| `POST` | `/events/:id/enroll` | `EventsController` | **user** & **admin** & **organizer** (owner) | Enroll the current user in an event. |
| `POST` | `/events/:id/cancel` | `EventsController` | **admin** | Cancel an ongoing event (admin only). |

**Role‑Based Access Summary**

| Role | Can Create Events? | Can Approve/Reject? | Can Enroll Users? | Can View All Events? |
|------|-------------------|--------------------|-------------------|----------------------|
| **admin** | ✅ | ✅ | ✅ | ✅ |
| **organizer** | ✅ (own events) | ✅ | ✅ (when enrolled) | ✅ (own events only) |
| **user** | ❌ | ❌ | ✅ (self‑enroll) | ✅ (public events) |
| **public (no auth)** | ❌ | ❌ | ❌ | ✅ (read‑only event list & single event) |

---

## Additional Observations

- **Validation & Business Logic** are centralized in service classes (`EventsService`, `OrganizerService`, etc.) and reinforced by **DTOs** (`CreateEventDto`, `UpdateEventDto`, etc.).  
- **Security** is enforced via NestJS **Guards** (`RolesGuard`) and **Decorators** (`@Roles`, `@Public`).  
- **Database Indexes**:  
  - `@Index(['eventDate', 'startTime'])` – query by date/time.  
  - `@Index(['approvalStatus', 'deletedAt'])` – filter pending/archived events.  
  - `@Index(['categoryId', 'eventDate'])` – category‑based temporal queries.  
- **Future Enhancements** (high‑level):  
  - Event **sub‑categories** for finer taxonomy.  
  - Integrated **notification system** (email/push) for status changes.  
  - Advanced **search & recommendation** using geolocation and user preferences.  
  - Ticket **allocation algorithms** (wait‑list, dynamic pricing).  

---

### How to Use This Document
- **Developers** can reference the **API catalog** to understand endpoint contracts and required permissions.  
- **Architects** can inspect the **entity models** to evaluate data‑model evolution paths.  
- **Product Owners** can map **user roles** to functional capabilities for roadmap planning.  

*All information reflects the current state of the `eventrix` backend codebase (as of 2026‑06‑25).*