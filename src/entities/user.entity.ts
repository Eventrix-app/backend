import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToMany,
  ManyToMany,
} from 'typeorm';
import { Event } from './event.entity';
import { Organizer } from './organizer.entity';
import { Enrollment } from './enrollment.entity';
import { AuthIdentity } from './auth-identity.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ name: 'full_name', type: 'varchar', nullable: true })
  fullName!: string;

  @Column({ name: 'phone_number', type: 'varchar', nullable: true })
  phoneNumber!: string | null;

  @Column({ name: 'password_hash', type: 'varchar', nullable: true })
  passwordHash!: string;

  @Column({ name: 'profile_picture_url', type: 'varchar', nullable: true })
  profilePictureUrl!: string;

  @Column({ type: 'varchar', nullable: true })
  bio!: string;

  @Column({ type: 'varchar', nullable: true })
  location!: string;

  @Column({ type: 'decimal', precision: 11, scale: 8, nullable: true })
  latitude!: number;

  @Column({ type: 'decimal', precision: 11, scale: 8, nullable: true })
  longitude!: number;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth!: string;

  @Column({ type: 'varchar', nullable: true })
  gender!: string;

  @Column({ type: 'jsonb', default: ['user'] })
  roles!: string[];

  @Column({ name: 'is_email_verified', default: false })
  isEmailVerified!: boolean;

  @Column({ name: 'is_phone_verified', default: false })
  isPhoneVerified!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deletedAt!: Date;

  @OneToMany(() => Organizer, (organizer) => organizer.user)
  organizers!: Organizer[];

  @OneToMany(() => Enrollment, (enrollment) => enrollment.user)
  enrollments!: Enrollment[];

  @OneToMany(() => AuthIdentity, (identity) => identity.user)
  authIdentities!: AuthIdentity[];

  @ManyToMany(() => Event, (event) => event.participants)
  enrolledIn!: Event[];
}
