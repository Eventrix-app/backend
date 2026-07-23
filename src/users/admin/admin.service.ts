import { ConflictException, ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { In, Raw, DataSource, EntityManager, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { User } from '../../entities/user.entity';

const BCRYPT_ROUNDS = 10;

// Arbitrary fixed key for the Postgres advisory lock bootstrap() takes — unique within
// this app (nothing else calls pg_advisory_xact_lock), just needs to be some constant both
// racing transactions agree on so the second one actually blocks on the first.
const ADMIN_BOOTSTRAP_LOCK_KEY = 913_224_001;

export interface AdminRecord {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  profilePictureUrl?: string;
  role: 'ADMIN';
  isActive: boolean;
  isBanned: boolean;
  bannedReason?: string;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  private parseMeta(bio: string | null): Record<string, string> {
    try {
      return bio ? JSON.parse(bio) : {};
    } catch {
      return {};
    }
  }

  private mapUserToAdminRecord(user: User): AdminRecord {
    const meta = this.parseMeta(user.bio);
    const [firstName, ...lastNames] = (user.fullName || '').split(' ');
    const lastName = lastNames.join(' ');
    return {
      id: user.id,
      username: meta['username'] || user.email.split('@')[0],
      email: user.email,
      firstName: firstName || '',
      lastName: lastName || '',
      phone: user.phoneNumber || undefined,
      profilePictureUrl: user.profilePictureUrl || undefined,
      role: 'ADMIN',
      isActive: !user.deletedAt,
      isBanned: user.isBanned,
      bannedReason: user.bannedReason || undefined,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  async countAdmins(): Promise<number> {
    return this.usersRepository.count({ where: { roles: Raw((alias) => `${alias} @> '["admin"]'::jsonb`) } });
  }

  // Two requests hitting this within the same instant can both run countAdmins() before
  // either's createAdmin() commits, both see 0 and both proceed — an unauthenticated
  // TOCTOU race letting two different callers each create a "first" admin. An advisory
  // lock scoped to the rest of this transaction makes the second racing call actually wait
  // for the first to finish (and commit) before it re-checks the count, so it correctly
  // sees the now-existing admin and gets the ForbiddenException instead of also succeeding.
  async bootstrap(createAdminDto: CreateAdminDto): Promise<AdminRecord> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_BOOTSTRAP_LOCK_KEY]);

      const adminCount = await manager.count(User, {
        where: { roles: Raw((alias) => `${alias} @> '["admin"]'::jsonb`) },
      });
      if (adminCount > 0) {
        throw new ForbiddenException(
          'Bootstrap is only allowed when no admin accounts exist',
        );
      }
      return this.createAdmin(createAdminDto, manager);
    });
  }

  async create(createAdminDto: CreateAdminDto): Promise<AdminRecord> {
    return this.createAdmin(createAdminDto);
  }

  private async createAdmin(createAdminDto: CreateAdminDto, manager?: EntityManager): Promise<AdminRecord> {
    const repo = manager ? manager.getRepository(User) : this.usersRepository;
    const existing = await repo.findOne({
      where: { email: createAdminDto.email },
    });
    if (existing) {
      throw new ConflictException('A user with this email already exists');
    }

    const { email, firstName, lastName, phone, username } = createAdminDto;
    const fullName = `${firstName} ${lastName}`.trim();
    const passwordHash = await bcrypt.hash(
      createAdminDto.password,
      BCRYPT_ROUNDS,
    );

    const user = repo.create({
      email,
      fullName,
      phoneNumber: phone ?? null,
      passwordHash,
      roles: ['admin'],
      bio: JSON.stringify({ username }),
      isEmailVerified: false,
      isPhoneVerified: false,
    });

    const savedUser = await repo.save(user);
    this.logger.log(`Created admin user in database: ${savedUser.email}`);
    return this.mapUserToAdminRecord(savedUser);
  }

  async findAll(
    page: number = 1,
    limit: number = 50,
  ): Promise<{ admins: AdminRecord[]; total: number; page: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    const [users, total] = await this.usersRepository.findAndCount({
      where: { roles: Raw((alias) => `${alias} @> '["admin"]'::jsonb`) },
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });
    return {
      admins: users.map((user) => this.mapUserToAdminRecord(user)),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string): Promise<AdminRecord> {
    const user = await this.usersRepository.findOne({
      where: { id, roles: Raw((alias) => `${alias} @> '["admin"]'::jsonb`) },
    });
    if (!user) {
      throw new NotFoundException(`Admin with id ${id} not found`);
    }
    return this.mapUserToAdminRecord(user);
  }

  async update(
    id: string,
    updateAdminDto: UpdateAdminDto,
  ): Promise<AdminRecord> {
    const user = await this.usersRepository.findOne({
      where: { id, roles: Raw((alias) => `${alias} @> '["admin"]'::jsonb`) },
    });
    if (!user) {
      throw new NotFoundException(`Admin with id ${id} not found`);
    }

    const { firstName, lastName, phone, password } = updateAdminDto;
    if (firstName !== undefined || lastName !== undefined) {
      const currentFirstName =
        firstName ?? (user.fullName || '').split(' ')[0] ?? '';
      const currentLastName =
        lastName ?? (user.fullName || '').split(' ').slice(1).join(' ') ?? '';
      user.fullName = `${currentFirstName} ${currentLastName}`.trim();
    }

    if (phone !== undefined) {
      user.phoneNumber = phone ?? null;
    }

    if (password) {
      user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    }

    const updatedUser = await this.usersRepository.save(user);
    this.logger.log(`Updated admin user in database: ${updatedUser.email}`);
    return this.mapUserToAdminRecord(updatedUser);
  }

  async remove(id: string): Promise<void> {
    const user = await this.usersRepository.findOne({
      where: { id, roles: Raw((alias) => `${alias} @> '["admin"]'::jsonb`) },
    });
    if (!user) {
      throw new NotFoundException(`Admin with id ${id} not found`);
    }

    // Soft delete to set deletedAt column
    await this.usersRepository.softRemove(user);
    this.logger.log(`Soft deleted admin user in database: ${user.email}`);
  }

  // Ban is intentionally separate from soft-delete: a banned account still exists (its
  // bookings/history are unaffected) but can no longer authenticate.
  async banUser(id: string, reason?: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User with id ${id} not found`);
    }
    user.isBanned = true;
    user.bannedReason = reason;
    await this.usersRepository.save(user);
    this.logger.log(`Banned user ${user.email}${reason ? `: ${reason}` : ''}`);
  }

  async unbanUser(id: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User with id ${id} not found`);
    }
    user.isBanned = false;
    user.bannedReason = undefined;
    await this.usersRepository.save(user);
    this.logger.log(`Unbanned user ${user.email}`);
  }
}
