import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UpdateOrganizerDto } from './dto/update-organizer.dto';
import { User } from '../../entities/user.entity';
import { Organizer } from '../../entities/organizer.entity';

const BCRYPT_ROUNDS = 10;

export interface OrganizerRecord {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  companyName: string;
  companyDescription?: string;
  companyWebsite?: string;
  companyLogoUrl?: string;
  verified: boolean;
  verifiedAt?: Date;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class OrganizerService {
  private readonly logger = new Logger(OrganizerService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Organizer)
    private readonly organizersRepository: Repository<Organizer>,
  ) {}

  private mapToRecord(user: User, organizer: Organizer): OrganizerRecord {
    const [firstName, ...lastNames] = (user.fullName || '').split(' ');
    return {
      id: organizer.id,
      userId: user.id,
      email: user.email,
      firstName: firstName || '',
      lastName: lastNames.join(' ') || '',
      phone: user.phoneNumber || undefined,
      companyName: organizer.companyName,
      companyDescription: organizer.companyDescription || undefined,
      companyWebsite: organizer.companyWebsite || undefined,
      companyLogoUrl: organizer.companyLogoUrl || undefined,
      verified: organizer.verified,
      verifiedAt: organizer.verifiedAt || undefined,
      isActive: !user.deletedAt,
      createdAt: organizer.createdAt.toISOString(),
      updatedAt: organizer.updatedAt.toISOString(),
    };
  }

  async findAll(): Promise<OrganizerRecord[]> {
    const organizers = await this.organizersRepository.find({
      relations: ['user'],
    });
    return organizers
      .filter((o) => o.user && !o.user.deletedAt)
      .map((o) => this.mapToRecord(o.user, o));
  }

  async findOne(id: string): Promise<OrganizerRecord> {
    const organizer = await this.organizersRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!organizer || !organizer.user || organizer.user.deletedAt) {
      throw new NotFoundException(`Organizer with id ${id} not found`);
    }
    return this.mapToRecord(organizer.user, organizer);
  }

  async update(id: string, dto: UpdateOrganizerDto): Promise<OrganizerRecord> {
    const organizer = await this.organizersRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!organizer || !organizer.user || organizer.user.deletedAt) {
      throw new NotFoundException(`Organizer with id ${id} not found`);
    }

    const user = organizer.user;

    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const [curFirst, ...curLast] = (user.fullName || '').split(' ');
      user.fullName =
        `${dto.firstName ?? curFirst} ${dto.lastName ?? curLast.join(' ')}`.trim();
    }
    if (dto.phone !== undefined) user.phoneNumber = dto.phone;
    if (dto.password) {
      user.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    }

    const savedUser = await this.usersRepository.save(user);
    const savedOrganizer = await this.organizersRepository.save(organizer);

    this.logger.log(`Updated organizer in database: ${savedUser.email}`);
    return this.mapToRecord(savedUser, savedOrganizer);
  }

  async remove(id: string): Promise<void> {
    const organizer = await this.organizersRepository.findOne({
      where: { id },
      relations: ['user'],
    });
    if (!organizer || !organizer.user || organizer.user.deletedAt) {
      throw new NotFoundException(`Organizer with id ${id} not found`);
    }
    await this.usersRepository.softRemove(organizer.user);
    this.logger.log(
      `Soft-deleted organizer user in database: ${organizer.user.email}`,
    );
  }
}
