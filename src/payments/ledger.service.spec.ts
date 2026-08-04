import { EntityManager } from 'typeorm';
import { LedgerService } from './ledger.service';
import { LedgerAccount, LedgerEntry, LedgerEntryType } from '../entities/ledger-entry.entity';
import { FeeBreakdown } from './fee-calculation.service';
import { FeePayer } from '../entities/event.entity';

// The manager is a pure pass-through here — these tests are about which accounts each entry
// names and whether the resulting set balances, not about persistence.
const mockManager = () =>
  ({
    create: jest.fn((_entity: unknown, dto: unknown) => dto),
    save: jest.fn((_entity: unknown, dto: unknown) => Promise.resolve(dto)),
  }) as unknown as EntityManager;

// Net movement per account: an entry moves `amount` OUT of debitAccount and INTO
// creditAccount (the convention recordPaymentLedger's own entries follow — a payment debits
// BUYER_ESCROW and credits ORGANIZER_PAYABLE).
function netByAccount(entries: Partial<LedgerEntry>[]): Record<string, number> {
  const net: Record<string, number> = {};
  for (const e of entries) {
    net[e.debitAccount!] = (net[e.debitAccount!] ?? 0) - e.amount!;
    net[e.creditAccount!] = (net[e.creditAccount!] ?? 0) + e.amount!;
  }
  return net;
}

describe('LedgerService', () => {
  let service: LedgerService;

  beforeEach(() => {
    service = new LedgerService();
  });

  // Mirrors FeeCalculationService.calculate(1000, { commissionRate: 10 }, ...) at
  // TAX_GST_RATE=18 — kept as literals so a change in the fee formula can't silently
  // redefine what these ledger assertions are testing.
  const PARTICIPANT_BREAKDOWN: FeeBreakdown = {
    ticketPrice: 1000,
    feePayer: FeePayer.PARTICIPANT,
    platformCommissionAmount: 100,
    gatewayFeeAmount: 23,
    gstAmount: 18,
    subtotalBeforeTax: 1123,
    buyerPrice: 1141,
    organizerPayout: 1000,
  };

  const ORGANIZER_BREAKDOWN: FeeBreakdown = {
    ticketPrice: 1000,
    feePayer: FeePayer.ORGANIZER,
    platformCommissionAmount: 100,
    gatewayFeeAmount: 23,
    gstAmount: 18,
    subtotalBeforeTax: 1000,
    buyerPrice: 1000,
    organizerPayout: 877,
  };

  describe('recordRefundLedger', () => {
    it('returns the GST liability to the account that funded it', async () => {
      const participant = await service.recordRefundLedger(mockManager(), 'r1', PARTICIPANT_BREAKDOWN, 'enr1');
      const organizer = await service.recordRefundLedger(mockManager(), 'r1', ORGANIZER_BREAKDOWN, 'enr1');

      const gstOf = (entries: Partial<LedgerEntry>[]) =>
        entries.find((e) => e.entryType === LedgerEntryType.GST_REVERSAL)!;

      expect(gstOf(participant).debitAccount).toBe(LedgerAccount.GST_OUTPUT_TAX);
      expect(gstOf(participant).creditAccount).toBe(LedgerAccount.ORGANIZER_PAYABLE);
      expect(gstOf(organizer).creditAccount).toBe(LedgerAccount.PLATFORM_REVENUE);
    });

    it('writes a reversal for every fee leg, not just the gross amount', async () => {
      const entries = await service.recordRefundLedger(mockManager(), 'r1', PARTICIPANT_BREAKDOWN, 'enr1');
      expect(entries.map((e) => e.entryType)).toEqual([
        LedgerEntryType.REFUND,
        LedgerEntryType.COMMISSION_REVERSAL,
        LedgerEntryType.GATEWAY_FEE_REVERSAL,
        LedgerEntryType.GST_REVERSAL,
      ]);
    });

    it('reverses only what exists — no fee legs on a zero-commission booking', async () => {
      const entries = await service.recordRefundLedger(
        mockManager(),
        'r1',
        { ...PARTICIPANT_BREAKDOWN, platformCommissionAmount: 0, gstAmount: 0 },
        'enr1',
      );
      expect(entries.map((e) => e.entryType)).toEqual([
        LedgerEntryType.REFUND,
        LedgerEntryType.GATEWAY_FEE_REVERSAL,
      ]);
    });
  });

  describe('recordPaymentLedger', () => {
    const participantBreakdown = PARTICIPANT_BREAKDOWN;
    const organizerBreakdown = ORGANIZER_BREAKDOWN;

    it('books GST out of the buyer-funded pool when the participant pays fees', async () => {
      const entries = await service.recordPaymentLedger(mockManager(), 'txn1', participantBreakdown, 'enr1');
      const gst = entries.find((e) => e.entryType === LedgerEntryType.GST_TAX)!;

      expect(gst.debitAccount).toBe(LedgerAccount.ORGANIZER_PAYABLE);
      expect(gst.creditAccount).toBe(LedgerAccount.GST_OUTPUT_TAX);
    });

    it('books GST against platform revenue when the organizer pays fees', async () => {
      const entries = await service.recordPaymentLedger(mockManager(), 'txn1', organizerBreakdown, 'enr1');
      const gst = entries.find((e) => e.entryType === LedgerEntryType.GST_TAX)!;

      expect(gst.debitAccount).toBe(LedgerAccount.PLATFORM_REVENUE);
      expect(gst.creditAccount).toBe(LedgerAccount.GST_OUTPUT_TAX);
    });

    // The invariant that actually matters: whatever is left sitting in ORGANIZER_PAYABLE after
    // a payment is booked has to be exactly what the T+3 payout sweep will later pay out
    // (settleEventPayout moves breakdown.organizerPayout and nothing else). Any mismatch is
    // money stranded in the ledger forever, which is precisely what booking participant-funded
    // GST against PLATFORM_REVENUE used to cause.
    it.each([
      ['participant pays fees', participantBreakdown],
      ['organizer pays fees', organizerBreakdown],
    ])('drains ORGANIZER_PAYABLE to exactly the organizer payout when %s', async (_label, breakdown) => {
      const entries = await service.recordPaymentLedger(mockManager(), 'txn1', breakdown, 'enr1');
      const net = netByAccount(entries);

      expect(net[LedgerAccount.ORGANIZER_PAYABLE]).toBeCloseTo(breakdown.organizerPayout, 2);
    });

    it('takes the full gross payment out of buyer escrow', async () => {
      const entries = await service.recordPaymentLedger(mockManager(), 'txn1', participantBreakdown, 'enr1');
      const net = netByAccount(entries);

      expect(net[LedgerAccount.BUYER_ESCROW]).toBeCloseTo(-participantBreakdown.buyerPrice, 2);
    });

    it('credits platform revenue the full commission when the buyer funded the GST', async () => {
      const entries = await service.recordPaymentLedger(mockManager(), 'txn1', participantBreakdown, 'enr1');
      const net = netByAccount(entries);

      // Not commission - gst: the platform earned all ₹100; the ₹18 remitted to the
      // government came from the buyer, not out of the platform's own fee.
      expect(net[LedgerAccount.PLATFORM_REVENUE]).toBeCloseTo(100, 2);
      expect(net[LedgerAccount.GST_OUTPUT_TAX]).toBeCloseTo(18, 2);
    });

    it('nets GST out of platform revenue when the platform absorbed it', async () => {
      const entries = await service.recordPaymentLedger(mockManager(), 'txn1', organizerBreakdown, 'enr1');
      const net = netByAccount(entries);

      expect(net[LedgerAccount.PLATFORM_REVENUE]).toBeCloseTo(100 - 18, 2);
      expect(net[LedgerAccount.GST_OUTPUT_TAX]).toBeCloseTo(18, 2);
    });

    it('omits the GST entry entirely while the rate is unset', async () => {
      const entries = await service.recordPaymentLedger(
        mockManager(),
        'txn1',
        { ...participantBreakdown, gstAmount: 0, buyerPrice: 1123, subtotalBeforeTax: 1123 },
        'enr1',
      );

      expect(entries.some((e) => e.entryType === LedgerEntryType.GST_TAX)).toBe(false);
      expect(netByAccount(entries)[LedgerAccount.ORGANIZER_PAYABLE]).toBeCloseTo(1000, 2);
    });

    // The whole point of reversing every leg: a refunded booking must leave no residue in
    // any account. Previously only the gross was reversed, so ORGANIZER_PAYABLE ended at
    // -(fees) and GST_OUTPUT_TAX kept the tax the buyer had already been refunded.
    it.each([
      ['participant pays fees', participantBreakdown],
      ['organizer pays fees', organizerBreakdown],
    ])('nets every account to zero after payment + full refund when %s', async (_label, breakdown) => {
      const paid = await service.recordPaymentLedger(mockManager(), 'txn1', breakdown, 'enr1');
      const refunded = await service.recordRefundLedger(mockManager(), 'refund1', breakdown, 'enr1');
      const net = netByAccount([...paid, ...refunded]);

      for (const account of Object.values(LedgerAccount)) {
        expect({ account, net: net[account] ?? 0 }).toEqual({ account, net: 0 });
      }
    });

    it('skips zero-value legs rather than writing noise rows for a free booking', async () => {
      const entries = await service.recordPaymentLedger(
        mockManager(),
        'txn1',
        {
          ticketPrice: 0,
          feePayer: FeePayer.ORGANIZER,
          platformCommissionAmount: 0,
          gatewayFeeAmount: 0,
          gstAmount: 0,
          subtotalBeforeTax: 0,
          buyerPrice: 0,
          organizerPayout: 0,
        },
        'enr1',
      );

      expect(entries).toHaveLength(0);
    });
  });
});
