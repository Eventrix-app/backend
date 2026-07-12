import { IsNotEmpty, IsString } from 'class-validator';

export class RejectRefundDto {
  @IsNotEmpty({ message: 'Rejection reason is required' })
  @IsString()
  reason!: string;
}
