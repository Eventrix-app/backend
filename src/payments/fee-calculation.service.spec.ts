import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FeeCalculationService } from './fee-calculation.service';
import { FeePayer } from '../entities/event.entity';

describe('FeeCalculationService', () => {
  let service: FeeCalculationService;
  let mockConfigService: { get: jest.Mock };

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn((key: string, fallback: number) => {
        if (key === 'gatewayFee.percent') return 2;
        if (key === 'gatewayFee.flat') return 3;
        return fallback;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [FeeCalculationService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get(FeeCalculationService);
  });

  it('applies no fees to free events', () => {
    const result = service.calculate(0, { commissionRate: 10, commissionFlatFee: 5 }, FeePayer.ORGANIZER);
    expect(result).toEqual({
      ticketPrice: 0,
      feePayer: FeePayer.ORGANIZER,
      platformCommissionAmount: 0,
      gatewayFeeAmount: 0,
      gstAmount: 0,
      subtotalBeforeTax: 0,
      buyerPrice: 0,
      organizerPayout: 0,
    });
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

  it('treats a missing/undefined commission config as zero fees beyond the gateway fee', () => {
    const result = service.calculate(200, { commissionRate: 0, commissionFlatFee: 0 }, FeePayer.ORGANIZER);
    expect(result.platformCommissionAmount).toBe(0);
    expect(result.gatewayFeeAmount).toBe(7); // 200 * 2% + 3
  });
});
