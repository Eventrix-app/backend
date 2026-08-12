import { numericTransformer } from './numeric.transformer';

// Entity columns using this are mocked in every other suite, so this is its only coverage
describe('numericTransformer', () => {
  const from = (v: unknown) => numericTransformer.from(v as string);

  it('converts the strings the pg driver actually returns for decimal columns', () => {
    expect(from('1050.00')).toBe(1050);
    expect(from('750.50')).toBe(750.5);
    expect(from('0.00')).toBe(0);
    expect(from('18.55620526')).toBe(18.55620526);
  });

  // What "amount.toFixed(2)" and "sum + amount" needed
  it('returns a real number, not a numeric-looking string', () => {
    expect(typeof from('1050.00')).toBe('number');
    expect((from('1050.00') as number) + (from('750.00') as number)).toBe(1800);
  });

  // commissionRate null = "apply platform default"; 0 = commission-free partner.
  // Number(null) is 0, which would silently convert one into the other.
  it('preserves null and undefined rather than collapsing them to 0', () => {
    expect(from(null)).toBeNull();
    expect(from(undefined)).toBeUndefined();
    expect(from(null)).not.toBe(0);
  });

  it('passes a number straight through', () => {
    expect(from(1050)).toBe(1050);
  });

  // NaN spreads silently through arithmetic and is hard to trace back here
  it('does not turn an unparseable value into NaN', () => {
    expect(from('not-a-number')).toBe('not-a-number');
  });

  // Pass-through: reformatting could impose a scale the column does not have
  it('leaves the write path untouched', () => {
    expect(numericTransformer.to(1050.5)).toBe(1050.5);
    expect(numericTransformer.to(null)).toBeNull();
  });
});
