// Shared by signup and checkout so the two can never disagree on what counts as payable.
// Collecting a number at registration is pointless if PayU later rejects the same value.
export function toTenDigitMobile(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  // Trailing 10 covers the country-code and trunk-prefix forms (+91…, 0091…, 0…) without
  // hardcoding a country: the subscriber number is what gateways actually want.
  const subscriber = digits.length > 10 ? digits.slice(-10) : digits;
  return subscriber.length === 10 ? subscriber : null;
}
