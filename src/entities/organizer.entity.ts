import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Event } from './event.entity';
import { User } from './user.entity';
import { Enrollment } from './enrollment.entity';

@Entity('organizers')
export class Organizer {
  @OneToMany(() => Event, (event) => event.organizer)
  events!: Event[];

  @OneToMany(() => Enrollment, (enrollment) => enrollment.event)
  enrollments!: Enrollment[];

  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, (user) => user.organizers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'company_name', type: 'varchar' })
  companyName!: string;

  @Column({ name: 'company_description', type: 'varchar', nullable: true })
  companyDescription!: string;

  @Column({ name: 'company_website', type: 'varchar', nullable: true })
  companyWebsite!: string;

  @Column({ name: 'company_logo_url', type: 'varchar', nullable: true })
  companyLogoUrl!: string;

  @Column({ default: false })
  verified!: boolean;

  @Column({ name: 'verified_at', nullable: true })
  verifiedAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt!: Date;
}
