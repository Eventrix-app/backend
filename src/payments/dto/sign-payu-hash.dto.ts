import { IsNotEmpty, IsString } from 'class-validator';

// The native PayU SDK's generateHash callback hands the app a raw string (minus salt) that
// needs signing — this DTO is that request. See PayUService.signHash.
export class SignPayUHashDto {
  @IsNotEmpty()
  @IsString()
  hashString!: string;
}
