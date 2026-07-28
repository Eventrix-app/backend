import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateShortCommentDto {
  // Trimmed before validation, so a body of only whitespace fails MinLength rather than
  // being stored as a blank comment that renders as an empty row in the sheet.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  body!: string;
}
