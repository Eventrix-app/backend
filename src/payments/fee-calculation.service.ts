import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeePayer } from '../entities/event.entity';

// Nullable on purpose: null/undefined means "this organizer has no negotiated rate — apply
// the platform default" (config `platform.commissionPercent`). An explicit number always
// wins, INCLUDING an explicit 0 for a commission-free partner. Callers must therefore pass
// the raw column through rather than coercing it with `?? 0`, which would silently turn
// every unconfigured organizer into a negotiated-zero one and defeat the default entirely.
export interface OrganizerCommissionConfig {
  commissionRate?: number | null; // percent, e.g. 10 = 10%
  commissionFlatFee?: number | null;
}

// Maps an organizer row (or its absence) to a commission config WITHOUT flattening null to 0.
// Every call site should go through this: `Number(organizer?.commissionRate ?? 0)` looks
// harmless but converts "no negotiated rate" into "negotiated 0%", which silently suppresses
// the platform default for every organizer who has never had a rate set — i.e. all of them.
// Decimal columns arrive from pg as strings, hence the Number() on the non-null branch.
//
// A missing organizer resolves to the platform default too, which is right for the
// fee-estimate preview a user sees before they have an organizer profile at all: it shows
// what they will actually be charged rather than an optimistic zero.
export function toCommissionConfig(
  organizer: { commissionRate?: number | null; commissionFlatFee?: number | null } | null | undefined,
): OrganizerCommissionConfig {
  return {
    commissionRate: organizer?.commissionRate == null ? null : Number(organizer.commissionRate),
    commissionFlatFee: organizer?.commissionFlatFee == null ? null : Number(organizer.commissionFlatFee),
  };
}

export interface FeeBreakdown {
  ticketPrice: number;
  feePayer: FeePayer;
  platformCommissionAmount: number;
  gatewayFeeAmount: number;
  gstAmount: number;
  subtotalBeforeTax: number;
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
    const gstRate = this.configService.get<number>('tax.gstRate', 0);

    // Free events. The attendee is charged nothing and no gateway is involved, but the
    // platform still takes a flat fee — which, having no payment to be netted out of,
    // accrues against the organizer as a receivable instead (see LedgerService's
    // recordFreeBookingLedger). buyerPrice stays 0, which is what keeps EventsService.
    // enroll()'s instant-confirm path for free bookings intact.
    //
    // organizerPayout is 0 rather than negative: it means "nothing is paid out", not "the
    // organizer is owed nothing". The debt lives in the ledger, and the payout sweep has no
    // concept of a negative payout to express it with.
    if (!price || price <= 0) {
      const freeEventFee = this.round(this.configService.get<number>('platform.freeEventFee', 12.5));
      return {
        ticketPrice: 0,
        feePayer,
        platformCommissionAmount: freeEventFee,
        gatewayFeeAmount: 0,
        gstAmount: this.round(freeEventFee * (gstRate / 100)),
        subtotalBeforeTax: 0,
        buyerPrice: 0,
        organizerPayout: 0,
      };
    }

    const gatewayFeePercent = this.configService.get<number>('gatewayFee.percent', 2);
    const gatewayFeeFlat = this.configService.get<number>('gatewayFee.flat', 3);

    // `?? platformDefault`, not `?? 0` — see OrganizerCommissionConfig. Only null/undefined
    // falls through to the default; an explicit 0 is honoured as a negotiated zero rate.
    const commissionRate =
      organizer.commissionRate ?? this.configService.get<number>('platform.commissionPercent', 5);
    const commissionFlatFee = organizer.commissionFlatFee ?? 0;

    const platformCommissionAmount = this.round(price * (Number(commissionRate) / 100) + Number(commissionFlatFee));
    const gatewayFeeAmount = this.round(price * (gatewayFeePercent / 100) + gatewayFeeFlat);
    const gstAmount = this.round(platformCommissionAmount * (gstRate / 100));

    const totalFees = platformCommissionAmount + gatewayFeeAmount + gstAmount;

    const buyerPrice = feePayer === FeePayer.PARTICIPANT ? this.round(price + totalFees) : price;
    const subtotalBeforeTax =
      feePayer === FeePayer.PARTICIPANT ? this.round(price + platformCommissionAmount + gatewayFeeAmount) : price;
    // Organizer payout is clamped at 0 — a misconfigured commission rate should never
    // produce a negative payout; it should read as "organizer receives nothing" instead.
    const organizerPayout =
      feePayer === FeePayer.PARTICIPANT ? price : Math.max(this.round(price - (platformCommissionAmount + gatewayFeeAmount)), 0);

    return {
      ticketPrice: price,
      feePayer,
      platformCommissionAmount,
      gatewayFeeAmount,
      gstAmount,
      subtotalBeforeTax,
      buyerPrice,
      organizerPayout,
    };
  }

  // Inverse of calculate(): recovers the breakdown from an amount that was ALREADY CHARGED,
  // rather than from a bare ticket price.
  //
  // This exists because enrollment.totalAmount is not always the ticket price. Under
  // feePayer=PARTICIPANT, EventsService.enroll() persists breakdown.buyerPrice — the
  // fee-inclusive total — so feeding it back into calculate() applies commission, gateway
  // fee and GST a SECOND time on top of a figure that already contains them. That silently
  // overpaid organizers (payout came out as the full buyer price, fees included), inflated
  // the commission/ledger rows, and overstated GST. Settlement, payout and invoicing must
  // all call this instead; only the pre-booking paths (enroll, waitlist promotion, the
  // fee-estimate endpoint) legitimately start from a bare price and call calculate().
  calculateFromChargedAmount(
    chargedAmount: number,
    organizer: OrganizerCommissionConfig,
    feePayer: FeePayer = FeePayer.ORGANIZER,
  ): FeeBreakdown {
    // Under ORGANIZER the buyer was charged exactly the ticket price (fees came out of the
    // organizer's side, never added on top) — the charged amount IS the base, no inversion.
    if (feePayer !== FeePayer.PARTICIPANT) {
      return this.calculate(chargedAmount, organizer, feePayer);
    }

    const charged = Number(chargedAmount);
    if (!charged || charged <= 0) {
      return this.calculate(0, organizer, feePayer);
    }

    const g = this.configService.get<number>('gatewayFee.percent', 2) / 100;
    const gf = this.configService.get<number>('gatewayFee.flat', 3);
    const t = this.configService.get<number>('tax.gstRate', 0) / 100;
    // Must resolve the platform default identically to calculate(), or the inverse would
    // invert a different formula than the one that produced the charged amount.
    const r =
      Number(organizer.commissionRate ?? this.configService.get<number>('platform.commissionPercent', 5)) / 100;
    const f = Number(organizer.commissionFlatFee ?? 0);

    // Forward formula, with each component's rounding dropped:
    //   charged = price(1 + r + g + r·t) + f + gf + f·t
    // Solving for price. The denominator is >= 1 for any non-negative rate, so it can
    // never divide by zero.
    const estimate = (charged - f - gf - f * t) / (1 + r + g + r * t);

    // calculate() rounds each component to 2dp independently, so the analytic estimate can
    // land a paisa or two off the true preimage. Scan the immediate neighbourhood for the
    // base price that forward-computes to EXACTLY the charged amount; comparison is in
    // integer paise for the same reason handlePayUReturn compares amounts that way.
    const targetPaise = Math.round(charged * 100);
    for (let deltaPaise = 0; deltaPaise <= 5; deltaPaise++) {
      for (const signed of deltaPaise === 0 ? [0] : [deltaPaise, -deltaPaise]) {
        const candidate = this.round(estimate + signed / 100);
        if (candidate < 0) continue;
        const breakdown = this.calculate(candidate, organizer, feePayer);
        if (Math.round(breakdown.buyerPrice * 100) === targetPaise) {
          return breakdown;
        }
      }
    }

    // No exact preimage — the commission/gateway/GST config has changed since this booking
    // was charged, so no ticket price under TODAY's rates produces the amount actually
    // taken. Fall back to the closest split, but pin buyerPrice to what was really charged:
    // an invoice must never claim a total the buyer was not billed, and the payout must not
    // silently drift with a config change. The residual lands on organizerPayout, which is
    // the correct place for it under PARTICIPANT (the organizer receives the base price).
    const approx = this.calculate(Math.max(this.round(estimate), 0), organizer, feePayer);
    const fees = this.round(approx.platformCommissionAmount + approx.gatewayFeeAmount + approx.gstAmount);
    return {
      ...approx,
      buyerPrice: this.round(charged),
      subtotalBeforeTax: this.round(charged - approx.gstAmount),
      organizerPayout: Math.max(this.round(charged - fees), 0),
    };
  }

  private round(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
