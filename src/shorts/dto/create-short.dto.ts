import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsObject, IsOptional, IsString, IsUUID, IsUrl, MaxLength, ValidateNested } from 'class-validator';
import { ShortOverlayDto } from './short-overlay.dto';

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

  // Text the creator placed over the video on the edit screen. Stored as JSON rather than
  // flattened into columns because it is a single opaque presentation blob that is only ever
  // read and written whole — nothing queries or sorts by its parts.
  //
  // @ValidateNested + @Type are both required: without them class-validator treats this as
  // a plain object and applies none of ShortOverlayDto's rules, which would let an
  // unvalidated blob straight into the column and out to every viewer's render path.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ShortOverlayDto)
  overlay?: ShortOverlayDto;
}
