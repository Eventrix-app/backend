import { validate } from 'class-validator';
import { CreateSignedUrlDto, UploadPurpose } from './create-signed-url.dto';

describe('CreateSignedUrlDto validation', () => {
  it.each(['image/png', 'image/jpeg', 'image/jpg', 'image/heic', 'image/webp'])(
    'accepts contentType %s',
    async (contentType) => {
      const dto = new CreateSignedUrlDto();
      dto.purpose = UploadPurpose.PROFILE_PICTURE;
      dto.contentType = contentType as any;

      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
    },
  );

  it.each(['image/gif', 'image/svg+xml', 'image/bmp', 'application/pdf', 'text/plain', ''])(
    'rejects contentType %s',
    async (contentType) => {
      const dto = new CreateSignedUrlDto();
      dto.purpose = UploadPurpose.PROFILE_PICTURE;
      dto.contentType = contentType as any;

      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      const constraints = errors.flatMap((e) => Object.keys(e.constraints ?? {}));
      expect(constraints).toContain('isIn');
    },
  );

  it('rejects an unknown purpose', async () => {
    const dto = new CreateSignedUrlDto();
    dto.purpose = 'avatar' as UploadPurpose;
    dto.contentType = 'image/png' as any;

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    const constraints = errors.flatMap((e) => Object.keys(e.constraints ?? {}));
    expect(constraints).toContain('isEnum');
  });
});
