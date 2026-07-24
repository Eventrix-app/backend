import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// Same durable-OTP pattern as PasswordResetOtp — a plain in-memory Map would silently break
// across Vercel's separate serverless containers. otpHash is a SHA-256 digest, never the
// plaintext code, which only ever exists in the email sent to the user.
@Entity('email_verification_otps')
@Index(['email'])
export class EmailVerificationOtp {
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
