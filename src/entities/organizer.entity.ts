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

export enum VerificationLevel {
  UNVERIFIED = 'unverified',
  EMAIL_VERIFIED = 'email_verified',
  PHONE_VERIFIED = 'phone_verified',
  DOCUMENT_VERIFIED = 'document_verified',
}

@Entity('organizers')
export class Organizer {
  @OneToMany(() => Event, (event) => event.organizer)
  events!: Event[];

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

  /** @deprecated superseded by verificationLevel; kept for backward compat / rollback safety. */
  @Column({ default: false })
  verified!: boolean;

  @Column({ name: 'verified_at', nullable: true })
  verifiedAt!: Date;

  @Column({
    name: 'verification_level',
    type: 'varchar',
    length: 20,
    enum: VerificationLevel,
    default: VerificationLevel.UNVERIFIED,
  })
  verificationLevel!: VerificationLevel;

  @Column({ name: 'auto_approve_events', type: 'boolean', default: false })
  autoApproveEvents!: boolean;

  @Column({ name: 'commission_rate', type: 'decimal', precision: 5, scale: 2, default: 0 })
  commissionRate!: number;

  @Column({ name: 'commission_flat_fee', type: 'decimal', precision: 10, scale: 2, default: 0 })
  commissionFlatFee!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt!: Date;
}
