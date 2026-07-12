import { IsArray, IsUUID, ArrayMinSize, ArrayUnique } from 'class-validator';

export class UpdateInterestsDto {
  @IsArray()
  @ArrayMinSize(3)
  // Without this, ["a", "b", "b"] passes the length-3 minimum but resolves to only 2
  // distinct categories once fetched — silently under-saving instead of erroring.
  @ArrayUnique({ message: 'categoryIds must not contain duplicates' })
  @IsUUID('4', { each: true })
  categoryIds!: string[];
}
