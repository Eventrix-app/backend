import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Block } from '../entities/block.entity';
import { User } from '../entities/user.entity';

export interface BlockedUserRecord {
  id: string;
  fullName: string;
  profilePictureUrl: string | null;
  blockedAt: Date;
}

@Injectable()
export class BlocksService {
  private readonly logger = new Logger(BlocksService.name);

  constructor(
    @InjectRepository(Block)
    private readonly blocksRepository: Repository<Block>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new BadRequestException('You cannot block yourself');
    }
    const exists = await this.usersRepository.exists({ where: { id: blockedId } });
    if (!exists) {
      throw new NotFoundException(`User ${blockedId} not found`);
    }

    const existing = await this.blocksRepository.findOne({ where: { blockerId, blockedId } });
    if (existing) return; // Already blocked — idempotent, not an error.

    await this.blocksRepository.save(this.blocksRepository.create({ blockerId, blockedId }));
    this.logger.log(`User ${blockerId} blocked user ${blockedId}`);
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.blocksRepository.delete({ blockerId, blockedId });
  }

  async listBlocked(blockerId: string): Promise<BlockedUserRecord[]> {
    const blocks = await this.blocksRepository.find({
      where: { blockerId },
      relations: ['blocked'],
      select: { blocked: { id: true, fullName: true, profilePictureUrl: true } },
      order: { createdAt: 'DESC' },
    });
    return blocks.map((b) => ({
      id: b.blocked.id,
      fullName: b.blocked.fullName,
      profilePictureUrl: b.blocked.profilePictureUrl ?? null,
      blockedAt: b.createdAt,
    }));
  }

  // Used by ChatService to filter a blocker's chat view — never exposed as a public
  // "who blocked me" endpoint (deliberately asymmetric, matching how most social apps
  // keep block lists private to the blocker).
  async getBlockedUserIds(blockerId: string): Promise<string[]> {
    const blocks = await this.blocksRepository.find({ where: { blockerId }, select: ['blockedId'] });
    return blocks.map((b) => b.blockedId);
  }
}
