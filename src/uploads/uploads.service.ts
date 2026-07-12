import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { AllowedUploadContentType, CreateSignedUrlDto, UploadPurpose } from './dto/create-signed-url.dto';

interface PurposeConfig {
  bucket: string;
  pathPrefix: string;
  // null = any authenticated user may request this purpose; otherwise the caller
  // must hold at least one of these roles. See multipart.md §3.2.
  allowedRoles: string[] | null;
}

// All four buckets are public — these are low-sensitivity, routinely-displayed
// assets, so public buckets get the best CDN cache hit rate with no signed-URL
// complexity on the read side (multipart.md §3.3). Buckets are provisioned in
// Supabase out-of-band; this map only decides which bucket+prefix a purpose lands in.
const PURPOSE_CONFIG: Record<UploadPurpose, PurposeConfig> = {
  [UploadPurpose.PROFILE_PICTURE]: { bucket: 'profile-pictures', pathPrefix: 'users', allowedRoles: null },
  [UploadPurpose.EVENT_IMAGE]: { bucket: 'event-images', pathPrefix: 'events', allowedRoles: ['organizer', 'admin'] },
  [UploadPurpose.EVENT_COVER]: { bucket: 'event-images', pathPrefix: 'event-covers', allowedRoles: ['organizer', 'admin'] },
  [UploadPurpose.COMPANY_LOGO]: { bucket: 'organizer-logos', pathPrefix: 'organizers', allowedRoles: ['organizer', 'admin'] },
};

// Kept in exact 1:1 correspondence with ALLOWED_UPLOAD_CONTENT_TYPES in the DTO.
const EXTENSION_BY_CONTENT_TYPE: Record<AllowedUploadContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/heic': 'heic',
  'image/webp': 'webp',
};

@Injectable()
export class UploadsService {
  constructor(private readonly configService: ConfigService) {}

  // Issues a signed PUT URL scoped to the correct bucket/path for the declared
  // purpose. Bytes never transit this server — the client PUTs directly to Supabase
  // Storage, then sends the returned publicUrl as a normal string field on the
  // existing participant/event/organizer create-or-update calls. See multipart.md §2-3.
  async createSignedUrl(
    dto: CreateSignedUrlDto,
    userId: string,
    userRoles: string[],
  ): Promise<{ uploadUrl: string; publicUrl: string }> {
    const config = PURPOSE_CONFIG[dto.purpose];

    if (config.allowedRoles && !config.allowedRoles.some((role) => userRoles.includes(role))) {
      throw new ForbiddenException(`Your role cannot request an upload URL for purpose "${dto.purpose}"`);
    }

    // Path-per-upload (UUID, never overwrite-in-place) so replacing an image sidesteps
    // CDN/browser cache staleness entirely instead of relying on invalidation delay.
    // contentType is guaranteed to be a key of this map — CreateSignedUrlDto's @IsIn
    // validates it on the HTTP path, and the deprecated forwarding route in
    // EventsController re-checks it explicitly since it bypasses ValidationPipe.
    const extension = EXTENSION_BY_CONTENT_TYPE[dto.contentType];
    const path = `${config.pathPrefix}/${userId}/${randomUUID()}.${extension}`;

    // Fail with a clear, actionable message instead of letting supabase-js's
    // "supabaseKey is required." leak out as an opaque, uncaught 500 — this is a
    // deployment/config problem (env vars not set locally), not a server bug.
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      throw new ServiceUnavailableException(
        'File uploads are not configured on this server (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).',
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase.storage.from(config.bucket).createSignedUploadUrl(path);
    if (error) {
      throw new InternalServerErrorException(`Failed to create upload URL: ${error.message}`);
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(config.bucket).getPublicUrl(path);

    return { uploadUrl: data.signedUrl, publicUrl };
  }
}
