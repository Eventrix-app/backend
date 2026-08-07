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
  // The commission inputs this breakdown was actually computed with, AFTER the platform
  // default has been resolved — i.e. never null once calculate() has run, even for an
  // organizer whose own commissionRate column is NULL. Exists so the settlement path can
  // freeze the effective rate onto the enrollment (see toFrozenFeeColumns) and answer
  // "what was I charged, and why" without re-resolving today's config.
  commissionRateApplied?: number | null;
  commissionFlatFeeApplied?: number | null;
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

    // Free events: the ORGANIZER publishes at no cost, and the PARTICIPANT pays a flat
    // registration fee (PLATFORM_FREE_EVENT_FEE, ₹12.50) instead. The whole fee is platform
    // revenue — the organizer receives nothing from a free registration.
    //
    // feePayer is forced to PARTICIPANT regardless of the event's own setting: there is no
    // ticket revenue for an organizer to absorb a fee out of, so "organizer pays" is not an
    // expressible option here.
    //
    // No gateway fee and no GST are charged ON TOP, by product decision — the participant
    // pays exactly ₹12.50, and the platform absorbs the real gateway cost out of it. That is
    // why gatewayFeeAmount is 0 rather than the usual 2% + ₹3: it is not that no gateway is
    // involved (a real PayU payment happens), it is that the buyer is not billed for it.
    if (!price || price <= 0) {
      const registrationFee = this.round(this.configService.get<number>('platform.freeEventFee', 12.5));
      return {
        ticketPrice: 0,
        feePayer: FeePayer.PARTICIPANT,
        platformCommissionAmount: registrationFee,
        gatewayFeeAmount: 0,
        gstAmount: 0,
        subtotalBeforeTax: registrationFee,
        buyerPrice: registrationFee,
        organizerPayout: 0,
        // The flat registration fee is not a percentage of anything — the organizer's
        // negotiated rate does not participate in a free event's split at all.
        commissionRateApplied: null,
        commissionFlatFeeApplied: registrationFee,
      };
    }

    const gatewayFeePercent = this.configService.get<number>('gatewayFee.percent', 2);
    const gatewayFeeFlat = this.configService.get<number>('gatewayFee.flat', 3);

    // `?? platformDefault`, not `?? 0` — see OrganizerCommissionConfig. Only null/undefined
    // falls through to the default; an explicit 0 is honoured as a negotiated zero rate.
    const commissionRate =
      organizer.commissionRate ?? this.configService.get<number>('platform.commissionPercent', 5);
    const commissionFlatFee = organizer.commissionFlatFee ?? 0;

    let platformCommissionAmount = this.round(price * (Number(commissionRate) / 100) + Number(commissionFlatFee));
    let gatewayFeeAmount = this.round(price * (gatewayFeePercent / 100) + gatewayFeeFlat);

    // Under ORGANIZER the fees are taken OUT of the ticket price, and there is nothing else
    // to take them from. On a cheap ticket they can exceed it outright — a ₹1 ticket owes
    // ₹3.02 in gateway fee alone, because that fee is 2% PLUS a flat ₹3.
    //
    // Previously this was handled by clamping organizerPayout at 0 while still booking the
    // full fees. That made the breakdown internally inconsistent — organizerPayout no longer
    // equalled price − fees — and the ledger inherited the inconsistency directly:
    // ORGANIZER_PAYABLE received `price` and had more than `price` debited out of it, going
    // negative by the shortfall on every such booking and quietly breaking the double-entry
    // invariant the whole reconciliation depends on.
    //
    // The fees are capped at what actually exists instead. The gateway fee yields last
    // because it is a real external cost PayU charges whatever we decide; commission is the
    // platform's own margin, so it absorbs the shortfall first and can fall to zero. The
    // platform eating the loss on an underpriced ticket is the honest outcome — the
    // alternative is a receivable against the organizer that nothing will ever collect.
    if (feePayer !== FeePayer.PARTICIPANT && platformCommissionAmount + gatewayFeeAmount > price) {
      gatewayFeeAmount = Math.min(gatewayFeeAmount, price);
      platformCommissionAmount = this.round(price - gatewayFeeAmount);
    }

    // Computed AFTER the cap, on the commission actually booked. GST on a commission that was
    // never charged is a liability against revenue that does not exist.
    const gstAmount = this.round(platformCommissionAmount * (gstRate / 100));

    const totalFees = platformCommissionAmount + gatewayFeeAmount + gstAmount;

    const buyerPrice = feePayer === FeePayer.PARTICIPANT ? this.round(price + totalFees) : price;
    const subtotalBeforeTax =
      feePayer === FeePayer.PARTICIPANT ? this.round(price + platformCommissionAmount + gatewayFeeAmount) : price;
    // No clamp needed any more: the cap above guarantees fees never exceed price, so this is
    // >= 0 by construction. Keeping a Math.max here would only hide a future regression in
    // the cap.
    const organizerPayout =
      feePayer === FeePayer.PARTICIPANT ? price : this.round(price - (platformCommissionAmount + gatewayFeeAmount));

    return {
      ticketPrice: price,
      feePayer,
      platformCommissionAmount,
      gatewayFeeAmount,
      gstAmount,
      subtotalBeforeTax,
      buyerPrice,
      organizerPayout,
      commissionRateApplied: Number(commissionRate),
      commissionFlatFeeApplied: Number(commissionFlatFee),
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
    // Whether the booking was for a FREE event. Cannot be inferred from the charged amount:
    // a free event's ₹12.50 registration fee and a genuine ₹12.50 ticket are the same number
    // with completely different splits. Without this flag the fee would be treated as a
    // ticket price — commission and gateway computed on it, and roughly ₹9 of the platform's
    // own ₹12.50 paid out to the organizer on every free registration.
    isFreeEvent = false,
  ): FeeBreakdown {
    if (isFreeEvent) {
      const charged = this.round(Number(chargedAmount) || 0);
      return {
        ticketPrice: 0,
        feePayer: FeePayer.PARTICIPANT,
        platformCommissionAmount: charged,
        gatewayFeeAmount: 0,
        gstAmount: 0,
        subtotalBeforeTax: charged,
        // Pinned to what was actually charged rather than recomputed from config, so a later
        // change to PLATFORM_FREE_EVENT_FEE cannot retroactively restate a settled booking.
        buyerPrice: charged,
        organizerPayout: 0,
        commissionRateApplied: null,
        commissionFlatFeeApplied: charged,
      };
    }

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

// The subset of Enrollment carrying the frozen split. Declared structurally rather than
// importing the entity so this file stays free of entity imports (it is a pure calculator).
export interface FrozenFeeColumns {
  totalAmount: number;
  feePayerApplied?: string | null;
  commissionRateApplied?: number | null;
  commissionFlatFeeApplied?: number | null;
  ticketBaseAmount?: number | null;
  platformFeeAmount?: number | null;
  gatewayFeeAmount?: number | null;
  gstAmount?: number | null;
  organizerPayoutAmount?: number | null;
  feesFrozenAt?: Date | null;
}

// The columns handleWebhook() stamps onto the enrollment at settlement. Kept next to
// readFrozenBreakdown() below so the write and the read can never disagree about shape.
export function toFrozenFeeColumns(breakdown: FeeBreakdown): Omit<FrozenFeeColumns, 'totalAmount'> {
  return {
    feePayerApplied: breakdown.feePayer,
    commissionRateApplied: breakdown.commissionRateApplied,
    commissionFlatFeeApplied: breakdown.commissionFlatFeeApplied,
    ticketBaseAmount: breakdown.ticketPrice,
    platformFeeAmount: breakdown.platformCommissionAmount,
    gatewayFeeAmount: breakdown.gatewayFeeAmount,
    gstAmount: breakdown.gstAmount,
    organizerPayoutAmount: breakdown.organizerPayout,
    feesFrozenAt: new Date(),
  };
}

// Rebuilds the breakdown from the frozen columns, or returns null if this booking predates
// the freeze (feesFrozenAt IS NULL) and the caller must fall back to recomputation.
//
// feesFrozenAt is the ONLY presence test. Checking an amount column instead would misread a
// legitimately-zero split (a commission-free partner, or a free event's organizer payout) as
// "not frozen" and silently drop back to live rates — exactly the retroactive behaviour the
// freeze exists to prevent.
//
// Decimal columns come back from pg as strings, hence Number() on every one.
export function readFrozenBreakdown(enrollment: FrozenFeeColumns): FeeBreakdown | null {
  if (!enrollment.feesFrozenAt) return null;

  const gstAmount = Number(enrollment.gstAmount ?? 0);
  const buyerPrice = Number(enrollment.totalAmount);

  return {
    ticketPrice: Number(enrollment.ticketBaseAmount ?? 0),
    feePayer: (enrollment.feePayerApplied as FeePayer) ?? FeePayer.ORGANIZER,
    platformCommissionAmount: Number(enrollment.platformFeeAmount ?? 0),
    gatewayFeeAmount: Number(enrollment.gatewayFeeAmount ?? 0),
    gstAmount,
    // Derived rather than stored: it is definitionally buyerPrice - gstAmount, and storing a
    // redundant column invites the two drifting apart.
    subtotalBeforeTax: Math.round((buyerPrice - gstAmount) * 100) / 100,
    // Pinned to what the buyer was actually charged — the authority for this is
    // enrollment.totalAmount, which the gateway already reconciled against.
    buyerPrice,
    organizerPayout: Number(enrollment.organizerPayoutAmount ?? 0),
    commissionRateApplied:
      enrollment.commissionRateApplied == null ? null : Number(enrollment.commissionRateApplied),
    commissionFlatFeeApplied:
      enrollment.commissionFlatFeeApplied == null ? null : Number(enrollment.commissionFlatFeeApplied),
  };
}
