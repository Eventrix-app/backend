import { IsString, Matches, MaxLength } from 'class-validator';

export class SendChatMessageDto {
  // @IsNotEmpty only rejects the literal empty string — a message of e.g. "   " passed it,
  // then ChatService.createMessage's .trim() turned it into an empty stored/broadcast
  // message. Requires at least one non-whitespace character instead.
  @Matches(/\S/, { message: 'Message cannot be empty' })
  @IsString()
  @MaxLength(2000, { message: 'Message must be 2000 characters or fewer' })
  message!: string;
}
