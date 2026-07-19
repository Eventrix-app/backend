import { IsEnum, IsNotEmpty, IsOptional, IsInt, IsUrl } from 'class-validator';
import { EventMediaType } from '../../entities/event-media.entity';

export class CreateEventMediaDto {
  @IsEnum(EventMediaType, { message: 'type must be either "image" or "video"' })
  type!: EventMediaType;

  @IsNotEmpty()
  @IsUrl()
  url!: string;

  @IsOptional()
  @IsInt()
  position?: number;
}
