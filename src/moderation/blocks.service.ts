import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Block } from '../entities/block.entity';
import { User } from '../entities/user.entity';
import { NotificationService } from '../notifications/notification.service';

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
    private readonly notificationService: NotificationService,
  ) {}

  async block(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) {
      throw new BadRequestException('You cannot block yourself');
    }
    const blocked = await this.usersRepository.findOne({ where: { id: blockedId }, select: ['id', 'fullName'] });
    if (!blocked) {
      throw new NotFoundException(`User ${blockedId} not found`);
    }

    const existing = await this.blocksRepository.findOne({ where: { blockerId, blockedId } });
    if (existing) return; // Already blocked — idempotent, not an error.

    await this.blocksRepository.save(this.blocksRepository.create({ blockerId, blockedId }));
    this.logger.log(`User ${blockerId} blocked user ${blockedId}`);
    // Blocks aren't a review queue (nothing for an admin to decide), but a user suddenly
    // being blocked by several people is the earliest signal of a bad actor — so it lands
    // in the dashboard feed as context. In-app + push only, never email (PUSH_ONLY_TYPES).
    void this.notifyAdminsOfBlock(blockerId, blockedId, blocked.fullName);
  }

  private async notifyAdminsOfBlock(blockerId: string, blockedId: string, blockedName: string): Promise<void> {
    try {
      const blocker = await this.usersRepository.findOne({ where: { id: blockerId }, select: ['fullName'] });
      await this.notificationService.notifyAdminsUserBlocked(
        blockerId,
        blocker?.fullName ?? 'A user',
        blockedId,
        blockedName,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to notify admins that user ${blockerId} blocked ${blockedId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
