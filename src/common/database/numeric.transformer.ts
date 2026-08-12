import { ValueTransformer } from 'typeorm';

/**
 * Postgres returns numeric/decimal as strings, so `amount.toFixed()` threw and `sum + amount`
 * concatenated. Null is preserved: null means "no negotiated rate", 0 means commission-free.
 */
export const numericTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,

  from: (value: string | number | null | undefined): number | null | undefined => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'number') return value;
    const parsed = Number(value);
    // Return unparseable values as-is; NaN would spread silently through arithmetic
    return Number.isFinite(parsed) ? parsed : (value as unknown as number);
  },
};
