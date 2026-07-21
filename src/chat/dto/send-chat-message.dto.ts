import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class SendChatMessageDto {
  @IsUUID()
  eventId!: string;

  @IsNotEmpty({ message: 'Message cannot be empty' })
  @IsString()
  @MaxLength(2000, { message: 'Message must be 2000 characters or fewer' })
  message!: string;
}
