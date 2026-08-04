import { IsNotEmpty, IsUUID } from 'class-validator';

export class InitiatePayUOrderDto {
  @IsNotEmpty({ message: 'enrollmentId is required' })
  @IsUUID()
  enrollmentId!: string;
}
