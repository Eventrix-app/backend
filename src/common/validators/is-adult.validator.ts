import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

// Applied to any date-of-birth field that must gate account creation to adults (organizer
// KYC already implies this in practice, but participant registration never enforced it —
// DOB was collected but nothing checked it). Compares calendar dates only (not time-of-day),
// so someone turns "old enough" on their actual birthday, not 24h later.
export function IsAdult(minAge: number, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAdult',
      target: object.constructor,
      propertyName,
      constraints: [minAge],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string' || !value) return false;
          const dob = new Date(value);
          if (Number.isNaN(dob.getTime())) return false;

          const [requiredAge] = args.constraints as [number];
          const cutoff = new Date();
          cutoff.setUTCFullYear(cutoff.getUTCFullYear() - requiredAge);
          return dob.getTime() <= cutoff.getTime();
        },
        defaultMessage(args: ValidationArguments): string {
          const [requiredAge] = args.constraints as [number];
          return `You must be at least ${requiredAge} years old to use this app`;
        },
      },
    });
  };
}
