// class-transformer's @Type decorator reads design-time metadata, which Nest loads at
// bootstrap but a bare DTO import under Jest does not. Without this the suite fails on
// "Reflect.getMetadata is not a function" before any assertion runs.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ALLOWED_OVERLAY_FONTS, ShortOverlayDto } from './short-overlay.dto';
import { CreateShortDto } from './create-short.dto';

function makeOverlay(overrides: Partial<ShortOverlayDto> = {}): ShortOverlayDto {
  return plainToInstance(ShortOverlayDto, {
    text: 'Great night',
    color: '#FFFFFF',
    fontFamily: ALLOWED_OVERLAY_FONTS[0],
    fontSizeRatio: 0.07,
    xRatio: 0.1,
    yRatio: -0.2,
    ...overrides,
  });
}

// This value is written by one client and then applied as real style props while rendering
// someone else's reel in every viewer's feed, so the bounds below are the point of the DTO.
describe('ShortOverlayDto validation', () => {
  it('accepts a well-formed overlay', async () => {
    expect(await validate(makeOverlay())).toHaveLength(0);
  });

  it.each(ALLOWED_OVERLAY_FONTS)('accepts registered font %s', async (fontFamily) => {
    expect(await validate(makeOverlay({ fontFamily }))).toHaveLength(0);
  });

  it.each(['Comic Sans', 'system-ui', '', 'ZalandoSansExpanded_400Regular'])(
    'rejects unregistered font %s',
    async (fontFamily) => {
      const errors = await validate(makeOverlay({ fontFamily }));
      expect(errors.map((e) => e.property)).toContain('fontFamily');
    },
  );

  it.each(['red', 'rgb(255,0,0)', 'javascript:alert(1)', ''])('rejects non-hex colour %s', async (color) => {
    const errors = await validate(makeOverlay({ color }));
    expect(errors.map((e) => e.property)).toContain('color');
  });

  it.each([0, 0.9, 5, -1])('rejects out-of-range fontSizeRatio %s', async (fontSizeRatio) => {
    const errors = await validate(makeOverlay({ fontSizeRatio }));
    expect(errors.map((e) => e.property)).toContain('fontSizeRatio');
  });

  it.each([-5, 5])('rejects out-of-range offset %s', async (value) => {
    const xErrors = await validate(makeOverlay({ xRatio: value }));
    expect(xErrors.map((e) => e.property)).toContain('xRatio');

    const yErrors = await validate(makeOverlay({ yRatio: value }));
    expect(yErrors.map((e) => e.property)).toContain('yRatio');
  });

  // Guards the @ValidateNested/@Type pair specifically: without both, class-validator treats
  // the nested object as opaque and silently accepts anything inside it, so every rule above
  // would pass through unenforced on the route that actually matters.
  describe('nested inside CreateShortDto', () => {
    const base = {
      mediaUrl: 'https://example.com/reel.mp4',
      eventId: '11111111-1111-4111-8111-111111111111',
    };

    it('accepts an absent overlay', async () => {
      const dto = plainToInstance(CreateShortDto, base);
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects an invalid overlay rather than storing it unchecked', async () => {
      const dto = plainToInstance(CreateShortDto, {
        ...base,
        overlay: { ...makeOverlay(), fontFamily: 'Comic Sans' },
      });

      const errors = await validate(dto);
      expect(errors.map((e) => e.property)).toContain('overlay');
    });
  });
});
