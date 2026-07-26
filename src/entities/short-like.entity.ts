import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Short } from './short.entity';
import { User } from './user.entity';

@Entity('short_likes')
@Unique(['userId', 'shortId'])
export class ShortLike {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'short_id', type: 'uuid' })
  shortId!: string;

  @ManyToOne(() => Short, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'short_id' })
  short!: Short;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
