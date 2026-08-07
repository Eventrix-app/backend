import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { FeeCalculationService, FeeBreakdown } from './fee-calculation.service';
import { LedgerService } from './ledger.service';
import { LedgerAccount, LedgerEntry } from '../entities/ledger-entry.entity';
import { FeePayer } from '../entities/event.entity';

/**
 * End-to-end money flow, with the REAL FeeCalculationService driving the REAL LedgerService.
 *
 * Every other payments spec mocks one side or the other, which means none of them can catch
 * the class of bug that has actually shipped here: a breakdown that is individually correct
 * and a set of ledger entries that is individually correct, which together fail to balance.
 * That is what stranded GST in ORGANIZER_PAYABLE, and what made refunds drift the fee total
 * negative on every reversal.
 *
 * The invariants asserted throughout:
 *
 *   1. Sum of all net account movements is exactly 0. Double-entry — every rupee that leaves
 *      one account arrives in another. A non-zero sum means money was created or destroyed.
 *   2. Net ORGANIZER_PAYABLE == breakdown.organizerPayout. This is the one the payout sweep
 *      depends on: the sweep pays organizerPayout and the payout ledger entry drains exactly
 *      that much, so any gap is a residue that sits in the account forever.
 *   3. Net BUYER_ESCROW == -buyerPrice. What the buyer actually paid, entering the system.
 *   4. After a payout and then a refund, every account nets to 0.
 *
 * Amounts are compared in integer paise. Ledger sums accumulate float rounding at the third
 * decimal, and a tolerance-based assertion here would hide exactly the paisa-level drift this
 * file exists to catch.
 */

const paise = (rupees: number) => Math.round(rupees * 100);

const captureManager = (sink: Partial<LedgerEntry>[]) =>
  ({
    create: jest.fn((_entity: unknown, dto: unknown) => dto),
    save: jest.fn((_entity: unknown, dto: unknown) => {
      sink.push(...(Array.isArray(dto) ? dto : [dto]));
      return Promise.resolve(dto);
    }),
  }) as unknown as EntityManager;

function netByAccount(entries: Partial<LedgerEntry>[]): Record<string, number> {
  const net: Record<string, number> = {};
  for (const e of entries) {
    net[e.debitAccount!] = (net[e.debitAccount!] ?? 0) - e.amount!;
    net[e.creditAccount!] = (net[e.creditAccount!] ?? 0) + e.amount!;
  }
  return net;
}

const totalPaise = (net: Record<string, number>) =>
  Object.values(net).reduce((sum, v) => sum + paise(v), 0);

describe('payment money flow (fee calculation → ledger)', () => {
  let fees: FeeCalculationService;
  let ledger: LedgerService;
  let gstRate: number;
  let commissionPercent: number;

  const build = () => {
    const config = {
      get: <T>(key: string, fallback?: T): T => {
        const values: Record<string, unknown> = {
          'tax.gstRate': gstRate,
          'platform.commissionPercent': commissionPercent,
          'platform.freeEventFee': 12.5,
          'gatewayFee.percent': 2,
          'gatewayFee.flat': 3,
        };
        return (values[key] ?? fallback) as T;
      },
    } as unknown as ConfigService;
    fees = new FeeCalculationService(config);
    ledger = new LedgerService();
  };

  beforeEach(() => {
    gstRate = 18;
    commissionPercent = 5;
    build();
  });

  // Books a payment and returns both the breakdown and the resulting net account movements.
  const settle = async (breakdown: FeeBreakdown) => {
    const entries: Partial<LedgerEntry>[] = [];
    await ledger.recordPaymentLedger(captureManager(entries), 'txn-1', breakdown, 'enr-1');
    return { entries, net: netByAccount(entries) };
  };

  const assertBalanced = (breakdown: FeeBreakdown, net: Record<string, number>) => {
    // 1. Nothing created, nothing destroyed.
    expect(totalPaise(net)).toBe(0);
    // 2. What the sweep will pay out is exactly what is sitting in ORGANIZER_PAYABLE.
    expect(paise(net[LedgerAccount.ORGANIZER_PAYABLE] ?? 0)).toBe(paise(breakdown.organizerPayout));
    // 3. What the buyer paid, entering the system.
    expect(paise(net[LedgerAccount.BUYER_ESCROW] ?? 0)).toBe(-paise(breakdown.buyerPrice));
  };

  describe('feePayer = ORGANIZER (the default)', () => {
    it('balances on a single ₹1000 ticket', async () => {
      const breakdown = fees.calculate(1000, { commissionRate: null }, FeePayer.ORGANIZER);

      // The buyer pays the sticker price; the organizer absorbs everything.
      expect(breakdown.buyerPrice).toBe(1000);
      expect(breakdown.platformCommissionAmount).toBe(50); // 5%
      expect(breakdown.gatewayFeeAmount).toBe(23); // 2% + ₹3
      expect(breakdown.gstAmount).toBe(9); // 18% of the ₹50 commission
      expect(breakdown.organizerPayout).toBe(927); // 1000 − 50 − 23

      const { net } = await settle(breakdown);
      assertBalanced(breakdown, net);

      // GST is funded by the platform's own commission here — nobody paid it on top, so it
      // cannot come out of ORGANIZER_PAYABLE. Booking it there is what stranded ₹9 per
      // booking forever while overstating platform revenue by the same amount.
      expect(paise(net[LedgerAccount.PLATFORM_REVENUE])).toBe(paise(50 - 9));
      expect(paise(net[LedgerAccount.GST_OUTPUT_TAX])).toBe(paise(9));
      expect(paise(net[LedgerAccount.GATEWAY_EXPENSE])).toBe(paise(23));
    });

    // The doc's headline test, run under the DEFAULT mode rather than only PARTICIPANT.
    // Under ORGANIZER the platform collects ₹10,000, not ₹10,820 — the fees come out of the
    // organizer's side, they are not added to the buyer's bill.
    it('balances across 10 tickets', async () => {
      const perTicket = fees.calculate(1000, { commissionRate: null }, FeePayer.ORGANIZER);
      let collected = 0;
      let owed = 0;
      const allEntries: Partial<LedgerEntry>[] = [];

      for (let i = 0; i < 10; i++) {
        const entries: Partial<LedgerEntry>[] = [];
        await ledger.recordPaymentLedger(captureManager(entries), `txn-${i}`, perTicket, `enr-${i}`);
        allEntries.push(...entries);
        collected += perTicket.buyerPrice;
        owed += perTicket.organizerPayout;
      }

      expect(collected).toBe(10_000);
      expect(owed).toBe(9_270);

      const net = netByAccount(allEntries);
      expect(totalPaise(net)).toBe(0);
      expect(paise(net[LedgerAccount.ORGANIZER_PAYABLE])).toBe(paise(9_270));
      // Collected − owed splits exactly across the three fee accounts. Nothing unaccounted.
      expect(
        paise(
          net[LedgerAccount.PLATFORM_REVENUE] +
            net[LedgerAccount.GATEWAY_EXPENSE] +
            net[LedgerAccount.GST_OUTPUT_TAX],
        ),
      ).toBe(paise(collected - owed));
    });
  });

  describe('feePayer = PARTICIPANT', () => {
    it('balances on a single ₹1000 ticket, with the buyer paying ₹1082', async () => {
      const breakdown = fees.calculate(1000, { commissionRate: null }, FeePayer.PARTICIPANT);

      expect(breakdown.buyerPrice).toBe(1082); // 1000 + 50 + 23 + 9
      expect(breakdown.organizerPayout).toBe(1000); // organizer keeps the full sticker price

      const { net } = await settle(breakdown);
      assertBalanced(breakdown, net);

      // Here the buyer DID pay the GST on top, so it arrived in ORGANIZER_PAYABLE with the
      // gross and must be remitted straight back out of there — the opposite account from
      // the ORGANIZER case above.
      expect(paise(net[LedgerAccount.PLATFORM_REVENUE])).toBe(paise(50));
      expect(paise(net[LedgerAccount.GST_OUTPUT_TAX])).toBe(paise(9));
    });

    // The doc's own arithmetic: ₹10,820 = 10,000 + 500 + 230 + 90. It holds — but only in
    // this mode, which is why the ORGANIZER case above exists alongside it.
    it('collects 10,820 across 10 tickets and splits it exactly', async () => {
      const perTicket = fees.calculate(1000, { commissionRate: null }, FeePayer.PARTICIPANT);
      const allEntries: Partial<LedgerEntry>[] = [];
      for (let i = 0; i < 10; i++) {
        const entries: Partial<LedgerEntry>[] = [];
        await ledger.recordPaymentLedger(captureManager(entries), `txn-${i}`, perTicket, `enr-${i}`);
        allEntries.push(...entries);
      }

      expect(perTicket.buyerPrice * 10).toBe(10_820);
      expect(10_820).toBe(10_000 + 500 + 230 + 90);

      const net = netByAccount(allEntries);
      expect(totalPaise(net)).toBe(0);
      expect(paise(net[LedgerAccount.ORGANIZER_PAYABLE])).toBe(paise(10_000));
      expect(paise(net[LedgerAccount.PLATFORM_REVENUE])).toBe(paise(500));
      expect(paise(net[LedgerAccount.GATEWAY_EXPENSE])).toBe(paise(230));
      expect(paise(net[LedgerAccount.GST_OUTPUT_TAX])).toBe(paise(90));
    });
  });

  describe('free events', () => {
    // The organizer earns nothing, so ORGANIZER_PAYABLE must drain to exactly 0 — the whole
    // ₹12.50 is platform revenue. A residue here would be paid out on the next sweep.
    it('books the entire registration fee as platform revenue, leaving nothing payable', async () => {
      const breakdown = fees.calculate(0, { commissionRate: 10, commissionFlatFee: 5 }, FeePayer.ORGANIZER);

      expect(breakdown.buyerPrice).toBe(12.5);
      expect(breakdown.organizerPayout).toBe(0);
      expect(breakdown.feePayer).toBe(FeePayer.PARTICIPANT); // forced

      const { net } = await settle(breakdown);
      assertBalanced(breakdown, net);
      expect(paise(net[LedgerAccount.ORGANIZER_PAYABLE] ?? 0)).toBe(0);
      expect(paise(net[LedgerAccount.PLATFORM_REVENUE])).toBe(paise(12.5));
    });
  });

  // GST is the leg most likely to be misrouted, and the only one whose correct destination
  // depends on feePayer. At rate 0 it must vanish entirely rather than write a zero row.
  describe('GST rate variations', () => {
    it.each([0, 5, 18, 28])('balances at a %i%% GST rate in both modes', async (rate) => {
      gstRate = rate;
      build();

      for (const feePayer of [FeePayer.ORGANIZER, FeePayer.PARTICIPANT]) {
        const breakdown = fees.calculate(1000, { commissionRate: null }, feePayer);
        const { net } = await settle(breakdown);
        assertBalanced(breakdown, net);
      }
    });

    it('writes no GST entry at all while the rate is unset', async () => {
      gstRate = 0;
      build();
      const { entries } = await settle(fees.calculate(1000, { commissionRate: null }, FeePayer.PARTICIPANT));
      expect(entries.some((e) => e.creditAccount === LedgerAccount.GST_OUTPUT_TAX)).toBe(false);
    });
  });

  // A negotiated 0% is a real deal, not "unset". Both must produce a balanced ledger, and
  // they must produce DIFFERENT payouts — conflating them is the bug the nullable columns
  // exist to prevent.
  describe('commission rate variations', () => {
    it.each([
      [null, 927],
      [0, 977],
      [5, 927],
      [20, 777],
    ])('balances at commissionRate %s (payout %i)', async (rate, expectedPayout) => {
      const breakdown = fees.calculate(1000, { commissionRate: rate as number | null }, FeePayer.ORGANIZER);
      expect(breakdown.organizerPayout).toBe(expectedPayout);
      const { net } = await settle(breakdown);
      assertBalanced(breakdown, net);
    });

    // Fees larger than the ticket price. The payout must reach 0 by CAPPING the fees, not by
    // clamping the payout while still booking them in full — the latter balanced the
    // breakdown's arithmetic on paper while leaving ORGANIZER_PAYABLE short by the overage
    // on every such booking.
    it('caps the fees at the ticket price rather than booking more than exists', async () => {
      const breakdown = fees.calculate(100, { commissionRate: 200 }, FeePayer.ORGANIZER);

      expect(breakdown.organizerPayout).toBe(0);
      // Commission (platform margin) absorbed the shortfall; the gateway fee, a real external
      // cost, was preserved in full.
      expect(breakdown.gatewayFeeAmount).toBe(5); // 2% of 100 + ₹3
      expect(breakdown.platformCommissionAmount).toBe(95); // capped from 200
      // GST follows the commission actually booked, not the one originally computed.
      expect(breakdown.gstAmount).toBe(17.1); // 18% of 95, not of 200

      const { net } = await settle(breakdown);
      assertBalanced(breakdown, net);
    });

    // The realistic version of the same problem: no misconfiguration at all, just a ticket
    // cheaper than the flat gateway fee. ₹1 owes ₹3.02 in gateway fee before any commission.
    it('balances a ticket cheaper than the flat gateway fee', async () => {
      const breakdown = fees.calculate(1, { commissionRate: null }, FeePayer.ORGANIZER);

      expect(breakdown.organizerPayout).toBe(0);
      expect(breakdown.gatewayFeeAmount).toBe(1); // capped at the whole ticket price
      expect(breakdown.platformCommissionAmount).toBe(0); // nothing left for the platform
      expect(breakdown.gstAmount).toBe(0);

      const { net } = await settle(breakdown);
      assertBalanced(breakdown, net);
    });
  });

  // Prices that don't divide cleanly into 2%/5%/18% are where paisa drift shows up.
  describe('awkward prices', () => {
    it.each([1, 33.33, 99.99, 149.5, 1234.56, 99_999.99])(
      'balances a ₹%s ticket in both modes',
      async (price) => {
        for (const feePayer of [FeePayer.ORGANIZER, FeePayer.PARTICIPANT]) {
          const breakdown = fees.calculate(price, { commissionRate: null }, feePayer);
          const { net } = await settle(breakdown);
          assertBalanced(breakdown, net);
        }
      },
    );
  });

  // The full lifecycle. This is the assertion that matters most for an audit: once a booking
  // has been paid, settled out, and refunded, the system must hold nothing on its behalf.
  describe('full lifecycle: payment → payout → refund', () => {
    // NOT zero, and correctly so. If the organizer has already been paid and the buyer is
    // then refunded, the platform is genuinely out of pocket by the payout amount: the money
    // went out twice and came in once. The residue is a real receivable against the
    // organizer, and the ledger is right to show it rather than nett it away.
    //
    // Nothing in this codebase collects that receivable — which is exactly why the T+3 delay
    // and the refund-window guard on the payout sweep matter. This test pins the size of the
    // exposure so a change to either is visible here.
    it.each([FeePayer.ORGANIZER, FeePayer.PARTICIPANT])(
      'leaves a receivable of exactly the payout amount under %s',
      async (feePayer) => {
        const breakdown = fees.calculate(1000, { commissionRate: null }, feePayer);
        const entries: Partial<LedgerEntry>[] = [];
        const manager = captureManager(entries);

        await ledger.recordPaymentLedger(manager, 'txn-1', breakdown, 'enr-1');
        await ledger.recordPayoutLedger(manager, 'payout-1', breakdown.organizerPayout, 'event-1');
        await ledger.recordRefundLedger(manager, 'refund-1', breakdown, 'enr-1');

        const net = netByAccount(entries);
        // Still balanced overall — no money invented, just misplaced.
        expect(totalPaise(net)).toBe(0);
        // The organizer holds money they should not: exactly what was paid out.
        expect(paise(net[LedgerAccount.ORGANIZER_PAYABLE])).toBe(-paise(breakdown.organizerPayout));
        expect(paise(net[LedgerAccount.BUYER_ESCROW])).toBe(paise(breakdown.organizerPayout));
        // The fee accounts, by contrast, are fully unwound — the platform kept nothing.
        expect(paise(net[LedgerAccount.PLATFORM_REVENUE] ?? 0)).toBe(0);
        expect(paise(net[LedgerAccount.GATEWAY_EXPENSE] ?? 0)).toBe(0);
        expect(paise(net[LedgerAccount.GST_OUTPUT_TAX] ?? 0)).toBe(0);
      },
    );

    // Refunded before the payout sweep ran — the ordinary case, and the one the refund
    // window is designed to keep everything inside. Nothing left behind anywhere.
    it.each([FeePayer.ORGANIZER, FeePayer.PARTICIPANT])(
      'nets to zero when refunded before payout under %s',
      async (feePayer) => {
        const breakdown = fees.calculate(1000, { commissionRate: null }, feePayer);
        const entries: Partial<LedgerEntry>[] = [];
        const manager = captureManager(entries);

        await ledger.recordPaymentLedger(manager, 'txn-1', breakdown, 'enr-1');
        await ledger.recordRefundLedger(manager, 'refund-1', breakdown, 'enr-1');

        const net = netByAccount(entries);
        for (const account of Object.values(LedgerAccount)) {
          expect({ account, paise: paise(net[account] ?? 0) }).toEqual({ account, paise: 0 });
        }
      },
    );

    it('nets a free-event booking to zero on refund', async () => {
      const breakdown = fees.calculate(0, { commissionRate: null }, FeePayer.PARTICIPANT);
      const entries: Partial<LedgerEntry>[] = [];
      const manager = captureManager(entries);

      await ledger.recordPaymentLedger(manager, 'txn-1', breakdown, 'enr-1');
      await ledger.recordRefundLedger(manager, 'refund-1', breakdown, 'enr-1');

      const net = netByAccount(entries);
      for (const account of Object.values(LedgerAccount)) {
        expect({ account, paise: paise(net[account] ?? 0) }).toEqual({ account, paise: 0 });
      }
    });
  });

  /**
   * The reconciliation contract.
   *
   * settleEventPayout compares its enrollment-derived payout against
   * LedgerService.getOrganizerPayableByEnrollment(), and blocks the payout if they disagree.
   * That comparison is only meaningful if the ledger's net ORGANIZER_PAYABLE for a booking
   * genuinely equals that booking's organizerPayout — which is asserted here directly,
   * across every mode, rather than assumed by the reconciler.
   */
  describe('reconciliation contract: ledger ORGANIZER_PAYABLE == organizerPayout', () => {
    it.each([
      ['ORGANIZER, ₹1000', 1000, FeePayer.ORGANIZER, null],
      ['PARTICIPANT, ₹1000', 1000, FeePayer.PARTICIPANT, null],
      ['ORGANIZER, ₹1000, 0% negotiated', 1000, FeePayer.ORGANIZER, 0],
      ['PARTICIPANT, ₹33.33', 33.33, FeePayer.PARTICIPANT, null],
      ['free event', 0, FeePayer.PARTICIPANT, null],
    ])('holds for %s', async (_label, price, feePayer, rate) => {
      const breakdown = fees.calculate(price as number, { commissionRate: rate as number | null }, feePayer as FeePayer);
      const { net } = await settle(breakdown);
      expect(paise(net[LedgerAccount.ORGANIZER_PAYABLE] ?? 0)).toBe(paise(breakdown.organizerPayout));
    });
  });

  /**
   * Why the freeze exists, demonstrated rather than asserted in prose.
   *
   * The ledger is written once, at payment time, against the rate in force then. If payout
   * later re-derives the split from the CURRENT rate, the two disagree — and the disagreement
   * is silent, because both numbers are individually correct for the rate each used.
   */
  describe('retroactive rate change', () => {
    it('makes the recomputed payout diverge from the ledger, which the freeze prevents', async () => {
      // Paid while the organizer was on a negotiated 0%.
      const atPaymentTime = fees.calculate(1000, { commissionRate: 0 }, FeePayer.ORGANIZER);
      const { net } = await settle(atPaymentTime);
      const ledgerSaysOwed = net[LedgerAccount.ORGANIZER_PAYABLE];
      expect(paise(ledgerSaysOwed)).toBe(paise(977));

      // An admin later moves them to 5%. Recomputing from the charged amount now yields a
      // different figure against the same, unchanged ledger.
      const recomputedLater = fees.calculateFromChargedAmount(1000, { commissionRate: 5 }, FeePayer.ORGANIZER);
      expect(recomputedLater.organizerPayout).toBe(927);
      expect(paise(recomputedLater.organizerPayout)).not.toBe(paise(ledgerSaysOwed));

      // The frozen columns record the payment-time answer, so payout still agrees with the
      // ledger — and the reconciliation check passes rather than blocking a valid payout.
      expect(paise(atPaymentTime.organizerPayout)).toBe(paise(ledgerSaysOwed));
    });
  });
});
