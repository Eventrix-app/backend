import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Short, ShortModerationStatus } from '../entities/short.entity';

const SAFE_UPLOADER_SELECT = {
  uploader: { id: true, fullName: true, email: true, profilePictureUrl: true },
} as const;

@Injectable()
export class ShortsService {
  constructor(
    @InjectRepository(Short)
    private readonly shortsRepository: Repository<Short>,
  ) {}

  async findAllForAdmin(filters: {
    moderationStatus?: ShortModerationStatus;
    page?: number;
    limit?: number;
  }): Promise<{ shorts: Short[]; total: number; page: number; totalPages: number }> {
    const { moderationStatus, page = 1, limit = 20 } = filters;
    const skip = (page - 1) * limit;
    const where: any = {};
    if (moderationStatus) where.moderationStatus = moderationStatus;

    const [shorts, total] = await this.shortsRepository.findAndCount({
      where,
      relations: ['uploader'],
      select: SAFE_UPLOADER_SELECT as any,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    });

    return { shorts, total, page, totalPages: Math.ceil(total / limit) };
  }

  private async findOrFail(id: string): Promise<Short> {
    const short = await this.shortsRepository.findOne({ where: { id } });
    if (!short) throw new NotFoundException(`Short ${id} not found`);
    return short;
  }

  async approve(id: string): Promise<Short> {
    const short = await this.findOrFail(id);
    short.moderationStatus = ShortModerationStatus.PUBLISHED;
    short.flagReason = undefined;
    return this.shortsRepository.save(short);
  }

  async remove(id: string, reason?: string): Promise<Short> {
    const short = await this.findOrFail(id);
    short.moderationStatus = ShortModerationStatus.REMOVED;
    short.flagReason = reason;
    return this.shortsRepository.save(short);
  }
}
