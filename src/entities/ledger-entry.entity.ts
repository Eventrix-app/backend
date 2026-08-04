import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export enum LedgerAccount {
  BUYER_ESCROW = 'buyer_escrow',
  ORGANIZER_PAYABLE = 'organizer_payable',
  PLATFORM_REVENUE = 'platform_revenue',
  GATEWAY_EXPENSE = 'gateway_expense',
  GST_OUTPUT_TAX = 'gst_output_tax',
}

export enum LedgerEntryType {
  PAYMENT = 'payment',
  COMMISSION = 'commission',
  GATEWAY_FEE = 'gateway_fee',
  GST_TAX = 'gst_tax',
  PAYOUT = 'payout',
  REFUND = 'refund',
  // Reversal counterparts, written together with REFUND so a refunded booking unwinds every
  // leg its payment created rather than only the gross amount. Without these the fees stayed
  // booked against a booking that no longer exists: ORGANIZER_PAYABLE went negative by the
  // fee total and GST_OUTPUT_TAX kept claiming tax that had been handed back to the buyer.
  // `entry_type` is a plain varchar column, so adding values here needs no migration.
  COMMISSION_REVERSAL = 'commission_reversal',
  GATEWAY_FEE_REVERSAL = 'gateway_fee_reversal',
  GST_REVERSAL = 'gst_reversal',
}

@Entity('ledger_entries')
@Index(['transactionId'])
@Index(['referenceId'])
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'transaction_id', type: 'varchar' })
  transactionId!: string;

  @Column({ name: 'debit_account', type: 'varchar' })
  debitAccount!: LedgerAccount;

  @Column({ name: 'credit_account', type: 'varchar' })
  creditAccount!: LedgerAccount;

  @Column({ name: 'amount', type: 'decimal', precision: 12, scale: 2 })
  amount!: number;

  @Column({ name: 'currency', type: 'varchar', default: 'INR' })
  currency!: string;

  @Column({ name: 'entry_type', type: 'varchar' })
  entryType!: LedgerEntryType;

  @Column({ name: 'reference_id', type: 'varchar', nullable: true })
  referenceId?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
