# Graph Report - .  (2026-07-09)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 676 nodes · 1249 edges · 35 communities (28 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 5 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ce272f50`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Event
- ParticipantService
- AdminService
- EventCategory
- participant.service.ts
- auth.module.ts
- scripts
- OrganizerService
- dependencies
- CreateEventDto
- devDependencies
- compilerOptions
- PreviewService
- data-source.ts
- app.module.ts
- Enrollment
- app.controller.ts
- user.entity.ts
- Organizer
- HttpExceptionFilter
- preview-server.js
- jwt.util.ts
- User
- test-preview.js
- nest-cli.json
- LoggingInterceptor
- database.module.ts
- EnhanceEventEntity1234567890123
- AddRolesToUser1660000000000
- AddDeletedAtToOrganizers1660000000001
- MigrateRoleToRoles1660000000002
- AddApprovalMethodAndTicketCode1660000000004
- tsconfig.build.json

## God Nodes (most connected - your core abstractions)
1. `User` - 44 edges
2. `Event` - 41 edges
3. `EventCategory` - 30 edges
4. `JwtPayload` - 27 edges
5. `Organizer` - 25 edges
6. `EventsService` - 25 edges
7. `Enrollment` - 23 edges
8. `CreateEventDto` - 23 edges
9. `compilerOptions` - 23 edges
10. `EventsController` - 19 edges

## Surprising Connections (you probably didn't know these)
- `validateEnv()` --references--> `joi`  [EXTRACTED]
  src/config/env.validation.ts → package.json
- `bootstrap()` --indirect_call--> `AppModule`  [INFERRED]
  src/main.ts → src/app.module.ts
- `bootstrap()` --indirect_call--> `HttpExceptionFilter`  [INFERRED]
  src/main.ts → src/common/filters/http-exception.filter.ts
- `AuthIdentity` --references--> `User`  [EXTRACTED]
  src/entities/auth-identity.entity.ts → src/entities/user.entity.ts
- `EventCategory` --references--> `Event`  [EXTRACTED]
  src/entities/category.entity.ts → src/entities/event.entity.ts

## Import Cycles
- 3-file cycle: `src/entities/category.entity.ts -> src/entities/event.entity.ts -> src/entities/user.entity.ts -> src/entities/category.entity.ts`
- 4-file cycle: `src/entities/category.entity.ts -> src/entities/event.entity.ts -> src/entities/organizer.entity.ts -> src/entities/user.entity.ts -> src/entities/category.entity.ts`

## Communities (35 total, 7 thin omitted)

### Community 0 - "Event"
Cohesion: 0.07
Nodes (30): BeforeInsert, BeforeUpdate, Query, JwtPayload, Event, Column, CreateDateColumn, DeleteDateColumn (+22 more)

### Community 1 - "ParticipantService"
Cohesion: 0.06
Nodes (32): Public(), CreateParticipantDto, IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, IsUrl (+24 more)

### Community 2 - "AdminService"
Cohesion: 0.07
Nodes (30): AdminController, ApiTags, Body, Controller, Delete, Get, Param, Patch (+22 more)

### Community 3 - "EventCategory"
Cohesion: 0.07
Nodes (32): EventCategory, Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, CategoryController, ApiTags (+24 more)

### Community 4 - "participant.service.ts"
Cohesion: 0.08
Nodes (26): Put, ArrayMinSize, IsArray, IsUUID, UpdateInterestsDto, IsNumber, Max, Min (+18 more)

### Community 5 - "auth.module.ts"
Cohesion: 0.10
Nodes (23): AuthController, ApiTags, Body, Controller, Post, Public, AuthService, BCRYPT_PREFIXES (+15 more)

### Community 6 - "scripts"
Cohesion: 0.06
Nodes (30): author, description, jest, collectCoverageFrom, coverageDirectory, moduleFileExtensions, rootDir, testEnvironment (+22 more)

### Community 7 - "OrganizerService"
Cohesion: 0.11
Nodes (17): Roles(), IsOptional, IsString, MinLength, UpdateOrganizerDto, OrganizerController, ApiTags, Body (+9 more)

### Community 8 - "dependencies"
Cohesion: 0.07
Nodes (29): dependencies, bcrypt, class-transformer, class-validator, cors, express, hbs, @nestjs/common (+21 more)

### Community 9 - "CreateEventDto"
Cohesion: 0.11
Nodes (23): IsDateString, IsInt, Matches, EventApprovalStatus, EventStatus, CreateEventDto, IsBoolean, IsEnum (+15 more)

### Community 10 - "devDependencies"
Cohesion: 0.08
Nodes (24): devDependencies, eslint, eslint-config-prettier, @eslint/eslintrc, @eslint/js, eslint-plugin-prettier, globals, jest (+16 more)

### Community 11 - "compilerOptions"
Cohesion: 0.08
Nodes (23): compilerOptions, allowSyntheticDefaultImports, baseUrl, declaration, emitDecoratorMetadata, esModuleInterop, experimentalDecorators, forceConsistentCasingInFileNames (+15 more)

### Community 12 - "PreviewService"
Cohesion: 0.15
Nodes (11): Render, PreviewController, ApiTags, Controller, Get, Public, PreviewModule, Module (+3 more)

### Community 13 - "data-source.ts"
Cohesion: 0.12
Nodes (13): AppDataSource, entities, AddOnboardingFields1660000000003, AuthIdentity, AuthProvider, Column, CreateDateColumn, Entity (+5 more)

### Community 14 - "app.module.ts"
Cohesion: 0.16
Nodes (10): joi, AuthModule, Module, validateEnv(), CrudModule, Module, EventsModule, Module (+2 more)

### Community 15 - "Enrollment"
Cohesion: 0.14
Nodes (11): Enrollment, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn (+3 more)

### Community 16 - "app.controller.ts"
Cohesion: 0.27
Nodes (6): AppController, Controller, Get, Public, AppService, Injectable

### Community 17 - "user.entity.ts"
Cohesion: 0.37
Nodes (3): entities, EnrollmentStatus, OrganizerRecord

### Community 18 - "Organizer"
Cohesion: 0.17
Nodes (11): Organizer, Column, CreateDateColumn, DeleteDateColumn, Entity, JoinColumn, ManyToOne, OneToMany (+3 more)

### Community 19 - "HttpExceptionFilter"
Cohesion: 0.27
Nodes (6): Catch, AppModule, Module, HttpExceptionFilter, setupSwagger(), bootstrap()

### Community 20 - "preview-server.js"
Cohesion: 0.24
Nodes (10): app, cors, express, frontendPath, isTsxFile(), { join, extname, basename }, parseComponentFile(), { readdir, readFile } (+2 more)

### Community 21 - "jwt.util.ts"
Cohesion: 0.18
Nodes (4): JwtAuthGuard, Injectable, RolesGuard, Injectable

### Community 22 - "User"
Cohesion: 0.20
Nodes (10): JoinTable, ManyToMany, Column, CreateDateColumn, DeleteDateColumn, Entity, OneToMany, PrimaryGeneratedColumn (+2 more)

### Community 23 - "test-preview.js"
Cohesion: 0.33
Nodes (8): frontendPath, isTsxFile(), { join, extname, basename }, main(), parseComponentFile(), { readdir, readFile }, scanComponents(), scanDirectory()

### Community 24 - "nest-cli.json"
Cohesion: 0.33
Nodes (5): collection, compilerOptions, deleteOutDir, $schema, sourceRoot

### Community 26 - "database.module.ts"
Cohesion: 0.40
Nodes (4): Global, getDatabaseConfig(), DatabaseModule, Module

## Knowledge Gaps
- **128 isolated node(s):** `$schema`, `collection`, `sourceRoot`, `deleteOutDir`, `name` (+123 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `scripts`, `app.module.ts`?**
  _High betweenness centrality (0.197) - this node is a cross-community bridge._
- **Why does `joi` connect `app.module.ts` to `dependencies`?**
  _High betweenness centrality (0.190) - this node is a cross-community bridge._
- **What connects `$schema`, `collection`, `sourceRoot` to the rest of the system?**
  _129 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Event` be split into smaller, more focused modules?**
  _Cohesion score 0.06965174129353234 - nodes in this community are weakly interconnected._
- **Should `ParticipantService` be split into smaller, more focused modules?**
  _Cohesion score 0.062409288824383166 - nodes in this community are weakly interconnected._
- **Should `AdminService` be split into smaller, more focused modules?**
  _Cohesion score 0.06531204644412192 - nodes in this community are weakly interconnected._
- **Should `EventCategory` be split into smaller, more focused modules?**
  _Cohesion score 0.06711915535444947 - nodes in this community are weakly interconnected._