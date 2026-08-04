import { IsIn, IsNotEmpty, IsNumberString, IsString } from 'class-validator';

// PayU posts this as an application/x-www-form-urlencoded body to whichever of surl/furl
// matched the payment outcome — every field arrives as a string (including amount), unlike
// PaymentWebhookDto's gateway-agnostic shape which expects a numeric amount.
export class PayUReturnDto {
  @IsNotEmpty()
  @IsString()
  txnid!: string;

  @IsNotEmpty()
  @IsString()
  mihpayid!: string;

  @IsIn(['success', 'failure'])
  status!: 'success' | 'failure';

  // @IsNumberString validates that the value is a numeric string (e.g. "1000.00"), not
  // just any string. This prevents crafted values like "" or "NaN" from passing the
  // controller null-check and producing NaN paise in the amount comparison, which would
  // silently bypass the enrollment amount verification in handlePayUReturn().
  @IsNumberString()
  amount!: string;

  @IsNotEmpty()
  @IsString()
  productinfo!: string;

  @IsNotEmpty()
  @IsString()
  firstname!: string;

  @IsNotEmpty()
  @IsString()
  email!: string;

  @IsNotEmpty()
  @IsString()
  hash!: string;
}
