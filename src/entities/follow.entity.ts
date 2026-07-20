import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Organizer } from './organizer.entity';
import { User } from './user.entity';

@Entity('follows')
@Unique(['userId', 'organizerId'])
export class Follow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'organizer_id', type: 'uuid' })
  organizerId!: string;

  @ManyToOne(() => Organizer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'organizer_id' })
  organizer!: Organizer;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
