import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOrganizerDto } from './update-organizer.dto';

// GSTIN lands on tax invoices issued to attendees, so a malformed one is a compliance
// problem rather than a display bug — validated at the edge instead of trusted.
// Format: 2-digit state code, 10-char PAN, 1-char entity number, 'Z', 1-char checksum.
describe('UpdateOrganizerDto — gstin', () => {
  const validateGstin = async (gstin: unknown) => {
    // plainToInstance (not `new`) so the @Transform that uppercases/trims actually runs,
    // matching how the global ValidationPipe builds the DTO.
    const dto = plainToInstance(UpdateOrganizerDto, { gstin });
    return { dto, errors: await validate(dto) };
  };

  it.each([
    ['29ABCDE1234F1Z5', 'standard'],
    ['07AABCU9603R1ZM', 'checksum letter'],
    ['33AAAAA0000A1Z0', 'numeric checksum'],
    ['09AAACH7409R1ZZ', 'entity number 1, checksum Z'],
  ])('accepts %s (%s)', async (gstin) => {
    const { errors } = await validateGstin(gstin);
    expect(errors).toHaveLength(0);
  });

  it('uppercases a lowercase entry rather than rejecting it', async () => {
    const { dto, errors } = await validateGstin('29abcde1234f1z5');
    expect(errors).toHaveLength(0);
    expect(dto.gstin).toBe('29ABCDE1234F1Z5');
  });

  it('trims surrounding whitespace from a pasted value', async () => {
    const { dto, errors } = await validateGstin('  29ABCDE1234F1Z5  ');
    expect(errors).toHaveLength(0);
    expect(dto.gstin).toBe('29ABCDE1234F1Z5');
  });

  it.each([
    ['29ABCDE1234F1Z', 'one character short'],
    ['29ABCDE1234F1Z55', 'one character long'],
    ['9ABCDE1234F1Z55', 'single-digit state code'],
    ['29ABCDE1234F1X5', "'Z' placeholder replaced"],
    ['29ABCD01234F1Z5', 'digit inside the PAN letters'],
    ['29ABCDE1234F0Z5', 'entity number 0'],
    ['ABCDE1234F1Z512', 'no leading state digits'],
    ['not-a-gstin', 'free text'],
    ['29ABCDE1234F1Z5; DROP TABLE organizers', 'trailing injection payload'],
  ])('rejects %s (%s)', async (gstin) => {
    const { errors } = await validateGstin(gstin);
    expect(errors).toHaveLength(1);
  });

  it('accepts an empty string, which clears the GSTIN on deregistration', async () => {
    const { errors } = await validateGstin('');
    expect(errors).toHaveLength(0);
  });

  it('accepts omission, leaving an existing GSTIN untouched', async () => {
    const dto = plainToInstance(UpdateOrganizerDto, {});
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.gstin).toBeUndefined();
  });
});
