import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Unique, Index } from 'typeorm';
import { User } from './user.entity';

// A blocks B — one-directional (B blocking A back requires its own separate row). Effect
// today is scoped to event chat: ChatService.getHistory excludes messages from anyone the
// requesting user has blocked. Reviews and other surfaces aren't filtered by block yet —
// blocking primarily matters for the real-time, interpersonal surface (chat); reviews are
// public/event-scoped commentary rather than direct interaction.
@Entity('blocks')
@Unique(['blockerId', 'blockedId'])
@Index(['blockerId'])
export class Block {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'blocker_id', type: 'uuid' })
  blockerId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'blocker_id' })
  blocker!: User;

  @Column({ name: 'blocked_id', type: 'uuid' })
  blockedId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'blocked_id' })
  blocked!: User;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
