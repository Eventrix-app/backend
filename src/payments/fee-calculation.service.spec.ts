import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FeeCalculationService } from './fee-calculation.service';
import { FeePayer } from '../entities/event.entity';

describe('FeeCalculationService', () => {
  let service: FeeCalculationService;
  let mockConfigService: { get: jest.Mock };
  let gstRate: number;

  // Built per-test so the GST block below can dial the rate up without every other case
  // (which asserts the GST-inert behaviour that ships by default) having to opt out.
  const build = async () => {
    mockConfigService = {
      get: jest.fn((key: string, fallback: number) => {
        if (key === 'gatewayFee.percent') return 2;
        if (key === 'gatewayFee.flat') return 3;
        if (key === 'tax.gstRate') return gstRate;
        return fallback;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [FeeCalculationService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get(FeeCalculationService);
  };

  beforeEach(async () => {
    // 0 = the shipped default (TAX_GST_RATE unset). See configuration.ts's `tax.gstRate`.
    gstRate = 0;
    await build();
  });

  // A free event costs the ORGANIZER nothing to publish; the PARTICIPANT pays a flat
  // registration fee instead. feePayer is forced to PARTICIPANT because there is no ticket
  // revenue for an organizer to absorb anything out of.
  it('charges the participant a flat registration fee on a free event', () => {
    const result = service.calculate(0, { commissionRate: 10, commissionFlatFee: 5 }, FeePayer.ORGANIZER);
    expect(result).toEqual({
      ticketPrice: 0,
      feePayer: FeePayer.PARTICIPANT, // forced, regardless of the event's own setting
      platformCommissionAmount: 12.5,
      gatewayFeeAmount: 0, // real gateway cost is absorbed by the platform, not billed on
      gstAmount: 0,
      subtotalBeforeTax: 12.5,
      buyerPrice: 12.5,
      organizerPayout: 0, // the organizer earns nothing from a free registration
      // The organizer's percentage rate does not participate in a free event's split at all,
      // so there is no rate to freeze onto the booking — the whole charge is the flat fee.
      commissionRateApplied: null,
      commissionFlatFeeApplied: 12.5,
    });
  });

  it('ignores the organizer commission rate on a free event — the flat fee replaces it', () => {
    const tenPercent = service.calculate(0, { commissionRate: 10, commissionFlatFee: 0 }, FeePayer.ORGANIZER);
    const zeroPercent = service.calculate(0, { commissionRate: 0, commissionFlatFee: 0 }, FeePayer.PARTICIPANT);
    expect(tenPercent.buyerPrice).toBe(12.5);
    expect(zeroPercent.buyerPrice).toBe(12.5);
  });

  it('buyer pays exactly ticket price when organizer absorbs fees (settled default)', () => {
    const result = service.calculate(500, { commissionRate: 10, commissionFlatFee: 0 }, FeePayer.ORGANIZER);
    // commission = 500 * 10% = 50; gateway fee = 500 * 2% + 3 = 13
    expect(result.buyerPrice).toBe(500);
    expect(result.platformCommissionAmount).toBe(50);
    expect(result.gatewayFeeAmount).toBe(13);
    expect(result.organizerPayout).toBe(500 - 50 - 13);
  });

  it('adds fees on top of ticket price when participant is the fee payer (opt-in mirror)', () => {
    const result = service.calculate(500, { commissionRate: 10, commissionFlatFee: 0 }, FeePayer.PARTICIPANT);
    expect(result.organizerPayout).toBe(500);
    expect(result.buyerPrice).toBe(500 + 50 + 13);
  });

  it('supports a flat-fee-only commission model (no percent component)', () => {
    const result = service.calculate(1000, { commissionRate: 0, commissionFlatFee: 25 }, FeePayer.ORGANIZER);
    expect(result.platformCommissionAmount).toBe(25);
  });

  it('supports a percent-only commission model (no flat component)', () => {
    const result = service.calculate(1000, { commissionRate: 5, commissionFlatFee: 0 }, FeePayer.ORGANIZER);
    expect(result.platformCommissionAmount).toBe(50);
  });

  it('combines percent + flat commission ("% + flat" model)', () => {
    const result = service.calculate(1000, { commissionRate: 5, commissionFlatFee: 10 }, FeePayer.ORGANIZER);
    expect(result.platformCommissionAmount).toBe(60);
  });

  it('rounds to 2 decimal places', () => {
    const result = service.calculate(99.99, { commissionRate: 3.33, commissionFlatFee: 1.111 }, FeePayer.ORGANIZER);
    expect(result.platformCommissionAmount).toBe(Math.round(result.platformCommissionAmount * 100) / 100);
    expect(result.gatewayFeeAmount).toBe(Math.round(result.gatewayFeeAmount * 100) / 100);
    expect(result.platformCommissionAmount).toBeCloseTo(4.44, 2);
  });

  it('clamps organizer payout at 0 instead of going negative on a misconfigured high commission', () => {
    const result = service.calculate(10, { commissionRate: 500, commissionFlatFee: 0 }, FeePayer.ORGANIZER);
    expect(result.organizerPayout).toBe(0);
  });

  it('honours an explicit 0% as a negotiated rate, not as "unset"', () => {
    const result = service.calculate(200, { commissionRate: 0, commissionFlatFee: 0 }, FeePayer.ORGANIZER);
    expect(result.platformCommissionAmount).toBe(0);
    expect(result.gatewayFeeAmount).toBe(7); // 200 * 2% + 3
  });

  // The distinction the nullable commission columns exist for: null means "no negotiated
  // rate", which must fall through to the platform default rather than being read as 0%.
  describe('platform default commission', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['absent config object', 'absent' as const],
    ])('applies the 5%% platform default when the rate is %s', (_label, rate) => {
      const config = rate === 'absent' ? {} : { commissionRate: rate, commissionFlatFee: null };
      const result = service.calculate(1000, config, FeePayer.PARTICIPANT);
      expect(result.platformCommissionAmount).toBe(50); // 1000 * 5%
    });

    it('lets an explicit rate override the platform default in both directions', () => {
      expect(service.calculate(1000, { commissionRate: 12 }, FeePayer.PARTICIPANT).platformCommissionAmount).toBe(120);
      expect(service.calculate(1000, { commissionRate: 0 }, FeePayer.PARTICIPANT).platformCommissionAmount).toBe(0);
    });

    it('round-trips through the inverse using the same default', () => {
      const forward = service.calculate(1000, { commissionRate: null }, FeePayer.PARTICIPANT);
      const back = service.calculateFromChargedAmount(forward.buyerPrice, { commissionRate: null }, FeePayer.PARTICIPANT);
      expect(back.organizerPayout).toBe(1000);
      expect(back.platformCommissionAmount).toBe(50);
    });
  });

  it('charges no GST at the default rate, so an unregistered deployment never collects tax', () => {
    const result = service.calculate(1000, { commissionRate: 10, commissionFlatFee: 0 }, FeePayer.PARTICIPANT);
    expect(result.gstAmount).toBe(0);
    // Buyer pays price + commission + gateway only — no phantom tax line.
    expect(result.buyerPrice).toBe(1000 + 100 + 23);
  });

  describe('with GST enabled at 18%', () => {
    beforeEach(async () => {
      gstRate = 18;
      await build();
    });

    it('taxes the platform commission, not the ticket price', () => {
      const result = service.calculate(1000, { commissionRate: 10, commissionFlatFee: 0 }, FeePayer.ORGANIZER);
      // 18% of the ₹100 commission — emphatically not 18% of the ₹1000 ticket.
      expect(result.gstAmount).toBe(18);
    });

    it('adds GST to what the buyer pays when the participant absorbs fees', () => {
      const result = service.calculate(1000, { commissionRate: 10, commissionFlatFee: 0 }, FeePayer.PARTICIPANT);
      expect(result.platformCommissionAmount).toBe(100);
      expect(result.gatewayFeeAmount).toBe(23);
      expect(result.gstAmount).toBe(18);
      expect(result.subtotalBeforeTax).toBe(1123);
      expect(result.buyerPrice).toBe(1141);
      // The organizer is made whole regardless — fees rode on top, not out of their cut.
      expect(result.organizerPayout).toBe(1000);
    });

    it('leaves the buyer price untouched when the organizer absorbs fees', () => {
      const result = service.calculate(1000, { commissionRate: 10, commissionFlatFee: 0 }, FeePayer.ORGANIZER);
      expect(result.buyerPrice).toBe(1000);
      // GST is absorbed by the platform out of its commission, so it does NOT come out of
      // the organizer's payout on top of commission + gateway fee.
      expect(result.organizerPayout).toBe(1000 - 100 - 23);
    });

    it('charges no GST on a zero commission, since there is no platform fee to tax', () => {
      const result = service.calculate(1000, { commissionRate: 0, commissionFlatFee: 0 }, FeePayer.PARTICIPANT);
      expect(result.gstAmount).toBe(0);
    });

    it('charges no GST on the free-event registration fee', () => {
      const result = service.calculate(0, { commissionRate: 10, commissionFlatFee: 5 }, FeePayer.PARTICIPANT);
      // Product decision: the participant pays exactly the flat fee, with nothing added on.
      expect(result.gstAmount).toBe(0);
      expect(result.buyerPrice).toBe(12.5);
    });
  });

  // enroll() persists breakdown.buyerPrice as enrollment.totalAmount under PARTICIPANT, so
  // settlement/payout/invoicing receive a fee-INCLUSIVE figure. Feeding that back into
  // calculate() double-applied every fee: the organizer was paid the full buyer price
  // (platform lost its entire commission), the Commission row and ledger were inflated, GST
  // was overstated, and the invoice showed a total the buyer was never charged.
  describe('calculateFromChargedAmount (inverse)', () => {
    const org = { commissionRate: 10, commissionFlatFee: 0 };

    it.each([
      ['GST disabled', 0],
      ['GST at 18%', 18],
    ])('round-trips exactly under PARTICIPANT with %s', async (_label, rate) => {
      gstRate = rate;
      await build();

      const atEnroll = service.calculate(1000, org, FeePayer.PARTICIPANT);
      // Exactly what enroll() writes to enrollment.totalAmount and charges the buyer.
      const charged = atEnroll.buyerPrice;

      const recovered = service.calculateFromChargedAmount(charged, org, FeePayer.PARTICIPANT);

      expect(recovered).toEqual(atEnroll);
      // The specific regressions, spelled out so they can't silently come back:
      expect(recovered.organizerPayout).toBe(1000);
      expect(recovered.buyerPrice).toBe(charged);
      expect(recovered.platformCommissionAmount).toBe(100);
    });

    it('does not pay the organizer the platform commission and gateway fee', async () => {
      gstRate = 18;
      await build();
      const charged = service.calculate(1000, org, FeePayer.PARTICIPANT).buyerPrice; // 1141

      const wrong = service.calculate(charged, org, FeePayer.PARTICIPANT).organizerPayout;
      const right = service.calculateFromChargedAmount(charged, org, FeePayer.PARTICIPANT).organizerPayout;

      expect(wrong).toBe(1141); // the old behaviour — buyer price paid straight through
      expect(right).toBe(1000);
    });

    it('is a pass-through under ORGANIZER, where the charged amount is the ticket price', () => {
      const direct = service.calculate(1000, org, FeePayer.ORGANIZER);
      const viaInverse = service.calculateFromChargedAmount(1000, org, FeePayer.ORGANIZER);
      expect(viaInverse).toEqual(direct);
      expect(viaInverse.organizerPayout).toBe(877);
    });

    it.each([1, 99.99, 250.5, 1000, 4999.95, 100000])(
      'round-trips price %p without rounding drift',
      async (price) => {
        gstRate = 18;
        await build();
        const forward = service.calculate(price, { commissionRate: 7.5, commissionFlatFee: 11 }, FeePayer.PARTICIPANT);
        const back = service.calculateFromChargedAmount(
          forward.buyerPrice,
          { commissionRate: 7.5, commissionFlatFee: 11 },
          FeePayer.PARTICIPANT,
        );
        expect(back.buyerPrice).toBe(forward.buyerPrice);
        expect(back.organizerPayout).toBe(forward.organizerPayout);
        expect(back.platformCommissionAmount).toBe(forward.platformCommissionAmount);
        expect(back.gstAmount).toBe(forward.gstAmount);
      },
    );

    it('splits a free booking as pure platform revenue, not as a ticket', () => {
      // 12.50 charged for a free event is a registration fee, not a 12.50 ticket. Without
      // the isFreeEvent flag the inverse would treat it as a ticket price and pay the
      // organizer most of the platform's own fee.
      const asFree = service.calculateFromChargedAmount(12.5, org, FeePayer.PARTICIPANT, true);
      expect(asFree.organizerPayout).toBe(0);
      expect(asFree.platformCommissionAmount).toBe(12.5);
      expect(asFree.buyerPrice).toBe(12.5);

      const asTicket = service.calculateFromChargedAmount(12.5, org, FeePayer.PARTICIPANT, false);
      expect(asTicket.organizerPayout).toBeGreaterThan(0);
    });

    it('never claims a total the buyer was not charged when rates changed since booking', async () => {
      gstRate = 18;
      await build();
      // Charged under a 10% commission, but the organizer is on 25% today — no ticket price
      // under current rates produces 1141, so there is no exact preimage.
      const recovered = service.calculateFromChargedAmount(
        1141,
        { commissionRate: 25, commissionFlatFee: 0 },
        FeePayer.PARTICIPANT,
      );
      expect(recovered.buyerPrice).toBe(1141);
      // And the payout still cannot exceed what was actually collected.
      expect(recovered.organizerPayout).toBeLessThanOrEqual(1141);
      expect(recovered.organizerPayout).toBeGreaterThan(0);
    });
  });
});
