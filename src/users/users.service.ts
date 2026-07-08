import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { EventCategory } from '../entities/category.entity';
import { UpdateInterestsDto } from './participant/dto/update-interests.dto';
import { UpdateLocationDto } from './participant/dto/update-location.dto';
import { UpdateNotificationPrefsDto } from './participant/dto/update-notification-prefs.dto';

export type CurrentUserResponse = {
  id: string;
  email: string;
  fullName: string | null;
  phoneNumber: string | null;
  profilePictureUrl: string | null;
  bio: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  notificationPrefs: UpdateNotificationPrefsDto | null;
  roles: string[];
  interests: EventCategory[];
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(EventCategory)
    private readonly categoryRepository: Repository<EventCategory>,
  ) {}

  async findMe(userId: string): Promise<CurrentUserResponse> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['interests'],
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName ?? null,
      phoneNumber: user.phoneNumber ?? null,
      profilePictureUrl: user.profilePictureUrl ?? null,
      bio: user.bio ?? null,
      location: user.location ?? null,
      latitude: user.latitude ?? null,
      longitude: user.longitude ?? null,
      notificationPrefs: user.notificationPrefs ?? null,
      roles: user.roles ?? [],
      interests: user.interests ?? [],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async updateInterests(userId: string, dto: UpdateInterestsDto): Promise<void> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['interests'],
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const categories = dto.categoryIds.length > 0
      ? await this.categoryRepository.findBy(dto.categoryIds.map((id) => ({ id })))
      : [];

    user.interests = categories;
    await this.usersRepository.save(user);
  }

  async updateLocation(userId: string, dto: UpdateLocationDto): Promise<void> {
    const result = await this.usersRepository.update(userId, {
      latitude: dto.latitude,
      longitude: dto.longitude,
    });

    if (result.affected === 0) {
      throw new NotFoundException(`User ${userId} not found`);
    }
  }

  async updateNotificationPrefs(userId: string, dto: UpdateNotificationPrefsDto): Promise<void> {
    const result = await this.usersRepository.update(userId, {
      notificationPrefs: dto,
    });

    if (result.affected === 0) {
      throw new NotFoundException(`User ${userId} not found`);
    }
  }
}