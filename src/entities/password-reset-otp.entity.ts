import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// Replaces AuthService's old static in-memory Map<email, {otp, expires}> — that store lived
// in one process's memory, which silently broke forgot-password/reset-password whenever the
// two requests landed on different Vercel serverless containers. This table is the durable,
// instance-independent equivalent. otpHash is a SHA-256 digest, not the plaintext code — the
// code itself only ever exists in the email sent to the user and in this row's hash.
@Entity('password_reset_otps')
@Index(['email'])
export class PasswordResetOtp {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  email!: string;

  @Column({ name: 'otp_hash', type: 'varchar' })
  otpHash!: string;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
