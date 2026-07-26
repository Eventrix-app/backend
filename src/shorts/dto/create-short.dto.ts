import { IsOptional, IsString, IsUUID, IsUrl, MaxLength } from 'class-validator';

export class CreateShortDto {
  @IsUrl()
  mediaUrl!: string;

  @IsOptional()
  @IsUrl()
  thumbnailUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2200)
  caption?: string;

  // Required — every reel belongs to exactly one event; uploads always launch from an
  // event context (see the Reel Upload screen design), never a bare/global picker.
  @IsUUID()
  eventId!: string;
}
