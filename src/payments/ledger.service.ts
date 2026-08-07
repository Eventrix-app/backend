import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { LedgerEntry, LedgerAccount, LedgerEntryType } from '../entities/ledger-entry.entity';
import { FeeBreakdown } from './fee-calculation.service';
import { FeePayer } from '../entities/event.entity';

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

    // 4. GST Output Tax on the platform fee. Which account funds it is NOT cosmetic — it is
    // what keeps ORGANIZER_PAYABLE draining to exactly the organizer's payout:
    //
    //   PARTICIPANT — the buyer paid GST on top (buyerPrice includes it), so it arrived in
    //     ORGANIZER_PAYABLE with the rest of the gross payment and must be remitted straight
    //     back out of there. Booking it against PLATFORM_REVENUE instead would strand exactly
    //     gstAmount in ORGANIZER_PAYABLE forever (the payout entry only moves organizerPayout,
    //     which excludes GST) while understating platform revenue by the same amount.
    //
    //   ORGANIZER — buyerPrice is the bare ticket price, so no one paid GST on top; the
    //     platform absorbs it out of the commission it just booked. ORGANIZER_PAYABLE has
    //     already drained to organizerPayout via entries 2 and 3 and must not be touched again.
    if (breakdown.gstAmount > 0) {
      entries.push({
        transactionId,
        debitAccount:
          breakdown.feePayer === FeePayer.PARTICIPANT ? LedgerAccount.ORGANIZER_PAYABLE : LedgerAccount.PLATFORM_REVENUE,
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
   * Records participant refund execution — the exact mirror of recordPaymentLedger.
   *
   * Every leg the payment wrote is reversed by swapping its debit and credit accounts, which
   * is what makes a fully refunded booking provably net to zero across all five accounts.
   * Reversing only the gross amount (the previous behaviour) left the commission, gateway
   * fee and GST booked forever against a booking that no longer exists: ORGANIZER_PAYABLE
   * drifted negative by the fee total on every refund, and GST_OUTPUT_TAX went on claiming
   * tax the buyer had already been given back — a real over-remittance once TAX_GST_RATE
   * is non-zero.
   *
   * Reversing commission means the platform gives up its fee on a refunded booking. That is
   * a deliberate policy choice, not an accounting necessity: to keep the fee instead, drop
   * the commission leg here and the residual becomes a genuine receivable from the organizer
   * — but it must then be collected somewhere, not left as an unexplained negative balance.
   *
   * The GST leg follows feePayer for the same reason recordPaymentLedger's does: it has to
   * return to whichever account funded it, or the reversal does not balance.
   */
  async recordRefundLedger(
    manager: EntityManager,
    transactionId: string,
    breakdown: FeeBreakdown,
    referenceId: string,
    currency = 'INR',
  ): Promise<LedgerEntry[]> {
    const entries: Partial<LedgerEntry>[] = [];

    // 1. Gross refund back to the buyer — mirrors the PAYMENT leg.
    if (breakdown.buyerPrice > 0) {
      entries.push({
        transactionId,
        debitAccount: LedgerAccount.ORGANIZER_PAYABLE,
        creditAccount: LedgerAccount.BUYER_ESCROW,
        amount: breakdown.buyerPrice,
        currency,
        entryType: LedgerEntryType.REFUND,
        referenceId,
      });
    }

    // 2. Commission returned — mirrors the COMMISSION leg.
    if (breakdown.platformCommissionAmount > 0) {
      entries.push({
        transactionId,
        debitAccount: LedgerAccount.PLATFORM_REVENUE,
        creditAccount: LedgerAccount.ORGANIZER_PAYABLE,
        amount: breakdown.platformCommissionAmount,
        currency,
        entryType: LedgerEntryType.COMMISSION_REVERSAL,
        referenceId,
      });
    }

    // 3. Gateway fee returned — mirrors the GATEWAY_FEE leg.
    //
    // NOTE: the real payment gateway does not usually refund its own processing fee. This
    // entry assumes it does. If PayU in fact retains it, this leg should instead move the
    // fee from ORGANIZER_PAYABLE (or PLATFORM_REVENUE, per policy) to GATEWAY_EXPENSE and
    // stay there — confirm against a real refunded transaction before relying on the
    // GATEWAY_EXPENSE balance for reconciliation.
    if (breakdown.gatewayFeeAmount > 0) {
      entries.push({
        transactionId,
        debitAccount: LedgerAccount.GATEWAY_EXPENSE,
        creditAccount: LedgerAccount.ORGANIZER_PAYABLE,
        amount: breakdown.gatewayFeeAmount,
        currency,
        entryType: LedgerEntryType.GATEWAY_FEE_REVERSAL,
        referenceId,
      });
    }

    // 4. GST liability released — mirrors the GST_TAX leg, back to whichever account funded
    // it (buyer's money under PARTICIPANT, the platform's own commission under ORGANIZER).
    if (breakdown.gstAmount > 0) {
      entries.push({
        transactionId,
        debitAccount: LedgerAccount.GST_OUTPUT_TAX,
        creditAccount:
          breakdown.feePayer === FeePayer.PARTICIPANT ? LedgerAccount.ORGANIZER_PAYABLE : LedgerAccount.PLATFORM_REVENUE,
        amount: breakdown.gstAmount,
        currency,
        entryType: LedgerEntryType.GST_REVERSAL,
        referenceId,
      });
    }

    const created = manager.create(LedgerEntry, entries);
    const saved = await manager.save(LedgerEntry, created);
    this.logger.log(`Recorded ${saved.length} refund reversal records for transaction ${transactionId}`);
    return saved;
  }

  /**
   * Net ORGANIZER_PAYABLE balance per enrollment, read straight from the ledger.
   *
   * This is the ledger's own answer to "what is the organizer owed for this booking", and it
   * exists so the payout sweep can CHECK its enrollment-derived figure against it instead of
   * ignoring the ledger entirely. Until this was added, the ledger was write-only: entries
   * were recorded on every payment and refund and never read back by anything, so the two
   * accounts of the same money could drift apart indefinitely with nothing to notice.
   *
   * Net = credits into ORGANIZER_PAYABLE minus debits out of it. That equals organizerPayout
   * for every mode by construction:
   *   PARTICIPANT ₹1082 → +1082 (payment) −50 (commission) −23 (gateway) −9 (GST) = 1000
   *   ORGANIZER   ₹1000 → +1000 (payment) −50 (commission) −23 (gateway)          =  927
   *                       (GST is funded by PLATFORM_REVENUE here, so it never touches this)
   *   free event  ₹12.50 → +12.50 (payment) −12.50 (commission)                   =    0
   *
   * PAYOUT entries are excluded: they debit ORGANIZER_PAYABLE to record the obligation
   * leaving, and are keyed by event_id rather than enrollment_id anyway. Including them
   * would make a second sweep over the same event reconcile against zero.
   *
   * Returns a map keyed by enrollment id. Enrollments absent from the map have NO ledger
   * entries at all — they predate the ledger (migration AddLedgerEntries) and cannot be
   * reconciled, which the caller must distinguish from a genuine mismatch of zero.
   */
  async getOrganizerPayableByEnrollment(
    manager: EntityManager,
    enrollmentIds: string[],
  ): Promise<Map<string, number>> {
    if (!enrollmentIds.length) return new Map();

    const rows = await manager
      .createQueryBuilder(LedgerEntry, 'entry')
      .select('entry.referenceId', 'referenceId')
      .addSelect(
        `SUM(
           CASE WHEN entry.credit_account = :payable THEN entry.amount
                WHEN entry.debit_account  = :payable THEN -entry.amount
                ELSE 0 END
         )`,
        'net',
      )
      .where('entry.referenceId IN (:...enrollmentIds)', { enrollmentIds })
      .andWhere('entry.entryType != :payout', { payout: LedgerEntryType.PAYOUT })
      .setParameter('payable', LedgerAccount.ORGANIZER_PAYABLE)
      .groupBy('entry.referenceId')
      .getRawMany<{ referenceId: string; net: string }>();

    // NUMERIC comes back from pg as a string; rounded to paise so the caller compares against
    // a value of the same precision rather than a float artefact.
    return new Map(rows.map((r) => [r.referenceId, Math.round(Number(r.net) * 100) / 100]));
  }
}
