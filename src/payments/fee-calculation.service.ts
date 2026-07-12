import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeePayer } from '../entities/event.entity';

export interface OrganizerCommissionConfig {
  commissionRate: number; // percent, e.g. 10 = 10%
  commissionFlatFee: number;
}

export interface FeeBreakdown {
  ticketPrice: number;
  feePayer: FeePayer;
  platformCommissionAmount: number;
  gatewayFeeAmount: number;
  // What the participant pays at checkout.
  buyerPrice: number;
  // What the organizer receives per ticket, net of commission + gateway fee.
  organizerPayout: number;
}

// The most bug-prone part of the system per the settled decisions doc — kept as a pure,
// side-effect-free function so it can be called standalone from the Create Event flow
// (for a live payout preview) as well as from the actual payment settlement path,
// guaranteeing both paths can never drift from each other.
@Injectable()
export class FeeCalculationService {
  constructor(private readonly configService: ConfigService) {}

  calculate(
    ticketPrice: number,
    organizer: OrganizerCommissionConfig,
    feePayer: FeePayer = FeePayer.ORGANIZER,
  ): FeeBreakdown {
    const price = Number(ticketPrice);

    // Free events: no commission/gateway fee applies either way.
    if (!price || price <= 0) {
      return {
        ticketPrice: 0,
        feePayer,
        platformCommissionAmount: 0,
        gatewayFeeAmount: 0,
        buyerPrice: 0,
        organizerPayout: 0,
      };
    }

    const gatewayFeePercent = this.configService.get<number>('gatewayFee.percent', 2);
    const gatewayFeeFlat = this.configService.get<number>('gatewayFee.flat', 3);

    const platformCommissionAmount = this.round(
      price * (Number(organizer.commissionRate ?? 0) / 100) + Number(organizer.commissionFlatFee ?? 0),
    );
    const gatewayFeeAmount = this.round(price * (gatewayFeePercent / 100) + gatewayFeeFlat);

    const totalFees = platformCommissionAmount + gatewayFeeAmount;

    const buyerPrice = feePayer === FeePayer.PARTICIPANT ? this.round(price + totalFees) : price;
    // Organizer payout is clamped at 0 — a misconfigured commission rate should never
    // produce a negative payout; it should read as "organizer receives nothing" instead.
    const organizerPayout =
      feePayer === FeePayer.PARTICIPANT ? price : Math.max(this.round(price - totalFees), 0);

    return {
      ticketPrice: price,
      feePayer,
      platformCommissionAmount,
      gatewayFeeAmount,
      buyerPrice,
      organizerPayout,
    };
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
