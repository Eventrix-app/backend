import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsString, IsUUID, IsUrl, MaxLength } from 'class-validator';

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

  // Uploader-chosen capture location. All optional: a user who declines the location
  // permission must still be able to post. Bounds-checked rather than merely typed as a
  // number, since these are rendered on a map and a garbage pair would place a marker
  // somewhere meaningless.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  locationName?: string;

  // @Type(() => Number) because IsLatitude/IsLongitude accept a string form too, and the
  // entity column is `decimal` — which TypeORM reads back as a string. Coercing on the way
  // in keeps what's stored consistent with what a JSON client sent.
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;
}
