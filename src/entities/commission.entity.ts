import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToOne,
  JoinColumn,
} from 'typeorm';
import { Payment } from './payment.entity';

@Entity('commissions')
export class Commission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'payment_id', type: 'uuid' })
  paymentId!: string;

  @OneToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;

  @Column({ name: 'platform_commission_amount', type: 'decimal', precision: 10, scale: 2, default: 0 })
  platformCommissionAmount!: number;

  @Column({ name: 'gateway_fee_amount', type: 'decimal', precision: 10, scale: 2, default: 0 })
  gatewayFeeAmount!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
