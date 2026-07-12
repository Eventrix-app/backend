import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class RequestRefundDto {
  @IsNotEmpty({ message: 'enrollmentId is required' })
  @IsUUID()
  enrollmentId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
