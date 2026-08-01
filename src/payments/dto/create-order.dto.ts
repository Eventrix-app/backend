import { IsNotEmpty, IsUUID } from 'class-validator';

export class CreateOrderDto {
  @IsNotEmpty({ message: 'enrollmentId is required' })
  @IsUUID()
  enrollmentId!: string;
}
