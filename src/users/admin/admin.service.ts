import { ConflictException, ForbiddenException, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { In, Raw } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateAdminDto } from './dto/update-admin.dto';
import { User } from '../../entities/user.entity';

const BCRYPT_ROUNDS = 10;

export interface AdminRecord {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: 'ADMIN';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
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
      role: 'ADMIN',
      isActive: !user.deletedAt,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  async countAdmins(): Promise<number> {
    return this.usersRepository.count({ where: { roles: Raw((alias) => `${alias} @> '["admin"]'::jsonb`) } });
  }

  async bootstrap(createAdminDto: CreateAdminDto): Promise<AdminRecord> {
    const adminCount = await this.countAdmins();
    if (adminCount > 0) {
      throw new ForbiddenException(
        'Bootstrap is only allowed when no admin accounts exist',
      );
    }
    return this.createAdmin(createAdminDto);
  }

  async create(createAdminDto: CreateAdminDto): Promise<AdminRecord> {
    return this.createAdmin(createAdminDto);
  }

  private async createAdmin(createAdminDto: CreateAdminDto): Promise<AdminRecord> {
    const existing = await this.usersRepository.findOne({
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

    const user = this.usersRepository.create({
      email,
      fullName,
      phoneNumber: phone ?? null,
      passwordHash,
      roles: ['admin'],
      bio: JSON.stringify({ username }),
      isEmailVerified: false,
      isPhoneVerified: false,
    });

    const savedUser = await this.usersRepository.save(user);
    this.logger.log(`Created admin user in database: ${savedUser.email}`);
    return this.mapUserToAdminRecord(savedUser);
  }

  async findAll(): Promise<AdminRecord[]> {
    const admins = await this.usersRepository.find({
      where: { roles: Raw((alias) => `${alias} @> '["admin"]'::jsonb`) },
    });
    return admins.map((user) => this.mapUserToAdminRecord(user));
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
