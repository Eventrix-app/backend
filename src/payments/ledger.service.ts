import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { LedgerEntry, LedgerAccount, LedgerEntryType } from '../entities/ledger-entry.entity';
import { FeeBreakdown } from './fee-calculation.service';

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  /**
   * Records balanced double-entry accounting records atomically inside a DB transaction.
   */
  async recordPaymentLedger(
    manager: EntityManager,
    transactionId: string,
    breakdown: FeeBreakdown,
    referenceId: string,
    currency = 'INR',
  ): Promise<LedgerEntry[]> {
    const entries: Partial<LedgerEntry>[] = [];

    // 1. Gross payment from Buyer into Escrow Account
    if (breakdown.buyerPrice > 0) {
      entries.push({
        transactionId,
        debitAccount: LedgerAccount.BUYER_ESCROW,
        creditAccount: LedgerAccount.ORGANIZER_PAYABLE,
        amount: breakdown.buyerPrice,
        currency,
        entryType: LedgerEntryType.PAYMENT,
        referenceId,
      });
    }

    // 2. Platform Commission from Organizer Payable to Platform Revenue
    if (breakdown.platformCommissionAmount > 0) {
      entries.push({
        transactionId,
        debitAccount: LedgerAccount.ORGANIZER_PAYABLE,
        creditAccount: LedgerAccount.PLATFORM_REVENUE,
        amount: breakdown.platformCommissionAmount,
        currency,
        entryType: LedgerEntryType.COMMISSION,
        referenceId,
      });
    }

    // 3. Gateway Fee from Organizer Payable to Gateway Expense
    if (breakdown.gatewayFeeAmount > 0) {
      entries.push({
        transactionId,
        debitAccount: LedgerAccount.ORGANIZER_PAYABLE,
        creditAccount: LedgerAccount.GATEWAY_EXPENSE,
        amount: breakdown.gatewayFeeAmount,
        currency,
        entryType: LedgerEntryType.GATEWAY_FEE,
        referenceId,
      });
    }

    // 4. GST Output Tax on platform fee
    if (breakdown.gstAmount > 0) {
      entries.push({
        transactionId,
        debitAccount: LedgerAccount.PLATFORM_REVENUE,
        creditAccount: LedgerAccount.GST_OUTPUT_TAX,
        amount: breakdown.gstAmount,
        currency,
        entryType: LedgerEntryType.GST_TAX,
        referenceId,
      });
    }

    const created = manager.create(LedgerEntry, entries);
    const saved = await manager.save(LedgerEntry, created);
    this.logger.log(`Recorded ${saved.length} double-entry ledger records for transaction ${transactionId}`);
    return saved;
  }

  /**
   * Records organizer payout execution.
   */
  async recordPayoutLedger(
    manager: EntityManager,
    transactionId: string,
    payoutAmount: number,
    referenceId: string,
    currency = 'INR',
  ): Promise<LedgerEntry> {
    const entry = manager.create(LedgerEntry, {
      transactionId,
      debitAccount: LedgerAccount.ORGANIZER_PAYABLE,
      creditAccount: LedgerAccount.BUYER_ESCROW,
      amount: payoutAmount,
      currency,
      entryType: LedgerEntryType.PAYOUT,
      referenceId,
    });
    return await manager.save(LedgerEntry, entry);
  }

  /**
   * Records participant refund execution.
   */
  async recordRefundLedger(
    manager: EntityManager,
    transactionId: string,
    refundAmount: number,
    referenceId: string,
    currency = 'INR',
  ): Promise<LedgerEntry> {
    const entry = manager.create(LedgerEntry, {
      transactionId,
      debitAccount: LedgerAccount.ORGANIZER_PAYABLE,
      creditAccount: LedgerAccount.BUYER_ESCROW,
      amount: refundAmount,
      currency,
      entryType: LedgerEntryType.REFUND,
      referenceId,
    });
    return await manager.save(LedgerEntry, entry);
  }
}
