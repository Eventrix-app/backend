import { IsNotEmpty, IsString } from 'class-validator';

export class UpdatePushTokenDto {
  @IsString()
  @IsNotEmpty({ message: 'pushToken is required' })
  pushToken!: string;
}
