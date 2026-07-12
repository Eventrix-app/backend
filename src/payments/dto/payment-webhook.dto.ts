import { IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { PaymentGateway } from '../../entities/payment.entity';

export class PaymentWebhookDto {
  @IsEnum(PaymentGateway, { message: 'Invalid gateway' })
  gateway!: PaymentGateway;

  // Unique per gateway event/notification — the idempotency key that dedupes retries.
  @IsNotEmpty()
  @IsString()
  gatewayEventId!: string;

  @IsOptional()
  @IsString()
  gatewayPaymentId?: string;

  @IsNotEmpty()
  @IsUUID()
  enrollmentId!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsIn(['success', 'failed'])
  status!: 'success' | 'failed';
}
