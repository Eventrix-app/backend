import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common';

// Drop-in replacement for ParseIntPipe on page/limit query params — an unbounded page
// (e.g. page=0 producing a negative SQL OFFSET) or limit (e.g. limit=5000000 forcing an
// unbounded findAndCount) previously reached the DB straight from an unauthenticated
// request. Pair with DefaultValuePipe so a missing param never hits this validation.
export class ParsePositiveIntPipe implements PipeTransform<string, number> {
  constructor(
    private readonly min: number,
    private readonly max: number,
  ) {}

  transform(value: string, metadata: ArgumentMetadata): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < this.min || parsed > this.max) {
      throw new BadRequestException(
        `${metadata.data ?? 'value'} must be an integer between ${this.min} and ${this.max}`,
      );
    }
    return parsed;
  }
}

export const ParsePageIntPipe = () => new ParsePositiveIntPipe(1, Number.MAX_SAFE_INTEGER);
export const ParseLimitIntPipe = () => new ParsePositiveIntPipe(1, 100);
