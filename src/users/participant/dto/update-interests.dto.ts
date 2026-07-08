import { IsArray, IsUUID, ArrayMinSize } from 'class-validator';

export class UpdateInterestsDto {
  @IsArray()
  @ArrayMinSize(3)
  @IsUUID('4', { each: true })
  categoryIds!: string[];
}
