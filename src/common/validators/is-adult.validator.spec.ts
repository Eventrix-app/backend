import { IsDateString, IsNotEmpty } from 'class-validator';
import { validate } from 'class-validator';
import { IsAdult } from './is-adult.validator';

class Fixture {
  @IsNotEmpty()
  @IsDateString()
  @IsAdult(18)
  dateOfBirth!: string;
}

function isoDateYearsAgo(years: number, dayOffset = 0): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

describe('IsAdult', () => {
  it('passes for someone exactly 18 today', async () => {
    const fixture = new Fixture();
    fixture.dateOfBirth = isoDateYearsAgo(18);
    expect(await validate(fixture)).toHaveLength(0);
  });

  it('passes for someone older than the minimum age', async () => {
    const fixture = new Fixture();
    fixture.dateOfBirth = isoDateYearsAgo(40);
    expect(await validate(fixture)).toHaveLength(0);
  });

  it('fails for someone who turns 18 tomorrow', async () => {
    const fixture = new Fixture();
    fixture.dateOfBirth = isoDateYearsAgo(18, 1);
    const errors = await validate(fixture);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty('isAdult');
  });

  it('fails for a young child', async () => {
    const fixture = new Fixture();
    fixture.dateOfBirth = isoDateYearsAgo(10);
    const errors = await validate(fixture);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails for a garbage date string', async () => {
    const fixture = new Fixture();
    fixture.dateOfBirth = 'not-a-date';
    const errors = await validate(fixture);
    expect(errors.length).toBeGreaterThan(0);
  });
});
