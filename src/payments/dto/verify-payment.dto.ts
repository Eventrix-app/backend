import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class VerifyPaymentDto {
  @IsNotEmpty()
  @IsUUID()
  enrollmentId!: string;

  @IsNotEmpty()
  @IsString()
  razorpayOrderId!: string;

  @IsNotEmpty()
  @IsString()
  razorpayPaymentId!: string;

  @IsNotEmpty()
  @IsString()
  razorpaySignature!: string;
}
