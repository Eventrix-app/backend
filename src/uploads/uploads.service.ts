import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { AllowedUploadContentType, CreateSignedUrlDto, UploadPurpose } from './dto/create-signed-url.dto';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB — plenty for a photo or ID-document scan
// 50MB, not more: the Supabase project's own global limit is 50MB, and asking for above it
// makes updateBucket fail silently, leaving the bucket on its old (10MB) limit.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

// Enforced by Supabase Storage on every signed upload, not just the client-declared
// contentType — nothing else stopped a client PUTting arbitrary bytes to a "png" path.
const BUCKET_CONSTRAINTS: Record<string, { public: boolean; allowedMimeTypes: string[]; maxBytes: number }> = {
  'profile-pictures': { public: true, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/jpg', 'image/heic', 'image/webp'], maxBytes: MAX_PHOTO_BYTES },
  'event-images': { public: true, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/jpg', 'image/heic', 'image/webp', 'video/mp4', 'video/quicktime'], maxBytes: MAX_VIDEO_BYTES },
  'organizer-logos': { public: true, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/jpg', 'image/heic', 'image/webp'], maxBytes: MAX_PHOTO_BYTES },
  // isPrivate in PURPOSE_CONFIG above — KYC document scans, never publicly readable.
  'organizer-kyc-docs': { public: false, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/jpg', 'image/heic', 'image/webp'], maxBytes: MAX_PHOTO_BYTES },
};

interface PurposeConfig {
  bucket: string;
  pathPrefix: string;
  // null = any authenticated user may request this purpose; otherwise the caller
  // must hold at least one of these roles. See multipart.md §3.2.
  allowedRoles: string[] | null;
  // KYC documents are sensitive PII, so these skip getPublicUrl() and return a raw storage
  // path; viewing one needs a fresh short-lived signed read URL.
  isPrivate?: boolean;
  // Rejects video even though the bucket allows it — the bucket-level allow-list is shared
  // by every purpose stored there, so image-only purposes need their own check.
  imageOnly?: boolean;
  // Tighter than the bucket's own limit, and only a UX guard: Storage's limit is what
  // actually enforces the upload.
  maxBytes?: number;
}

const CATEGORY_ICON_MAX_BYTES = 2 * 1024 * 1024; // 2MB — matches the admin dashboard's own check

  // Public buckets everywhere except KYC: routinely-displayed assets get the best CDN hit
  // rate with no signed-URL complexity on reads.
const PURPOSE_CONFIG: Record<UploadPurpose, PurposeConfig> = {
  [UploadPurpose.PROFILE_PICTURE]: { bucket: 'profile-pictures', pathPrefix: 'users', allowedRoles: null },
  [UploadPurpose.EVENT_IMAGE]: { bucket: 'event-images', pathPrefix: 'events', allowedRoles: ['organizer', 'admin'] },
  [UploadPurpose.EVENT_COVER]: { bucket: 'event-images', pathPrefix: 'event-covers', allowedRoles: ['organizer', 'admin'], imageOnly: true },
  [UploadPurpose.COMPANY_LOGO]: { bucket: 'organizer-logos', pathPrefix: 'organizers', allowedRoles: ['organizer', 'admin'] },
  // allowedRoles: null — applicants aren't organizers yet at the point they submit these.
  [UploadPurpose.IDENTITY_PROOF]: { bucket: 'organizer-kyc-docs', pathPrefix: 'identity-proof', allowedRoles: null, isPrivate: true },
  [UploadPurpose.ADDRESS_PROOF]: { bucket: 'organizer-kyc-docs', pathPrefix: 'address-proof', allowedRoles: null, isPrivate: true },
  [UploadPurpose.PAN_OR_AADHAAR]: { bucket: 'organizer-kyc-docs', pathPrefix: 'pan-or-aadhaar', allowedRoles: null, isPrivate: true },
  // Reuses event-images (already public, already allows video). allowedRoles is null since
  // reel uploaders are attendees, not organizers.
  [UploadPurpose.REEL_VIDEO]: { bucket: 'event-images', pathPrefix: 'reels', allowedRoles: null },
  // A frame extracted from the reel client-side — same allowedRoles as REEL_VIDEO, imageOnly
  // since there's never a reason for this purpose to receive video bytes.
  [UploadPurpose.REEL_THUMBNAIL]: { bucket: 'event-images', pathPrefix: 'reel-thumbnails', allowedRoles: null, imageOnly: true },
  // Reuses event-images too — a category icon is just another admin-managed image, not
  // worth its own bucket.
  [UploadPurpose.CATEGORY_ICON]: { bucket: 'event-images', pathPrefix: 'category-icons', allowedRoles: ['admin'], imageOnly: true, maxBytes: CATEGORY_ICON_MAX_BYTES },
};

// Kept in exact 1:1 correspondence with ALLOWED_UPLOAD_CONTENT_TYPES in the DTO.
const EXTENSION_BY_CONTENT_TYPE: Record<AllowedUploadContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/heic': 'heic',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

@Injectable()
export class UploadsService implements OnModuleInit {
  private readonly logger = new Logger(UploadsService.name);

  constructor(private readonly configService: ConfigService) {}

  // Idempotent bucket-constraint sync on boot, so limits live here rather than in a
  // dashboard setting someone can forget. Must never fail startup — warn and skip.
  async onModuleInit(): Promise<void> {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      this.logger.warn('Skipping upload bucket constraint sync — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not configured');
      return;
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    for (const [bucket, constraints] of Object.entries(BUCKET_CONSTRAINTS)) {
      const { error } = await supabase.storage.updateBucket(bucket, {
        public: constraints.public,
        fileSizeLimit: constraints.maxBytes,
        allowedMimeTypes: constraints.allowedMimeTypes,
      });
      if (error) {
        // error, not warn: on failure the bucket keeps its old limits and the only symptom is
        // a Storage 400 that never mentions the bucket.
        this.logger.error(
          `Could not sync upload constraints for bucket "${bucket}": ${error.message}. ` +
            `Uploads to this bucket will be rejected by Storage if its existing limits are narrower than expected.`,
        );
      } else {
        // Logged on success too, so "did the video MIME types actually get applied?" is
        // answerable from the boot log instead of the Supabase dashboard.
        this.logger.log(
          `Synced bucket "${bucket}": ${Math.round(constraints.maxBytes / (1024 * 1024))}MB max, ` +
            `types [${constraints.allowedMimeTypes.join(', ')}]`,
        );
      }
    }
  }

  // Bytes never transit this server — the client PUTs straight to Supabase Storage and sends
  // the returned publicUrl as a normal field on the existing create/update calls.
  async createSignedUrl(
    dto: CreateSignedUrlDto,
    userId: string,
    userRoles: string[],
  ): Promise<{ uploadUrl: string; publicUrl: string }> {
    const config = PURPOSE_CONFIG[dto.purpose];

    if (config.allowedRoles && !config.allowedRoles.some((role) => userRoles.includes(role))) {
      throw new ForbiddenException(`Your role cannot request an upload URL for purpose "${dto.purpose}"`);
    }

    if (config.imageOnly && dto.contentType.startsWith('video/')) {
      throw new BadRequestException(`Purpose "${dto.purpose}" does not accept video uploads`);
    }

    if (config.maxBytes && dto.fileSize && dto.fileSize > config.maxBytes) {
      throw new BadRequestException(`File exceeds the ${Math.round(config.maxBytes / (1024 * 1024))}MB limit for purpose "${dto.purpose}"`);
    }

    // Path-per-upload (UUID, never overwrite) so replacing an image sidesteps CDN staleness
    // instead of relying on invalidation delay.
    const extension = EXTENSION_BY_CONTENT_TYPE[dto.contentType];
    const path = `${config.pathPrefix}/${userId}/${randomUUID()}.${extension}`;

    // Clear config error instead of supabase-js's opaque "supabaseKey is required." 500 —
    // this is a deployment problem, not a server bug.
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

    // Private (KYC) purposes: the bucket has no public read access, so getPublicUrl() would
    // return a URL that 404s. Return the raw storage path instead — the caller stores this
    // opaque path in the DB and must go through createSignedReadUrl() below to ever view it.
    if (config.isPrivate) {
      return { uploadUrl: data.signedUrl, publicUrl: path };
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from(config.bucket).getPublicUrl(path);

    return { uploadUrl: data.signedUrl, publicUrl };
  }

  // Nothing ties a URL a client submits on a create/update DTO (companyLogoUrl,
  // coverImageUrl, etc.) back to a signed upload actually issued for that field — a client
  // could submit any externally-hosted URL, or reuse a URL obtained for a *different*
  // purpose (e.g. a profile-picture upload as an event cover). This checks the URL is both
  // hosted on this app's own Supabase project and under the exact bucket+path prefix the
  // named purpose issues, closing both gaps for whichever field calls it. Only meaningful
  // for public-bucket purposes — isPrivate purposes never hand back a real URL to validate.
  assertPublicUrlMatchesPurpose(url: string, purpose: UploadPurpose): void {
    const config = PURPOSE_CONFIG[purpose];
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    if (!supabaseUrl) {
      // Uploads are already unusable app-wide without this configured (createSignedUrl
      // throws ServiceUnavailableException) — nothing to validate against.
      return;
    }
    const expectedPrefix = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${config.bucket}/${config.pathPrefix}/`;
    if (!url.startsWith(expectedPrefix)) {
      throw new BadRequestException(`Invalid URL for this field — it must be an upload obtained for purpose "${purpose}"`);
    }
  }

  // Mints a short-lived (5 min) signed read URL for a stored KYC document path, so an
  // admin reviewing a verification submission can view the actual image without the
  // document ever being publicly/permanently accessible. Only IDENTITY_PROOF/
  // ADDRESS_PROOF/PAN_OR_AADHAAR are stored as paths (see isPrivate above); any other
  // string passed in here is already a real public URL and has no business going through
  // this method, so the caller (OrganizerController, admin-only) is what scopes this down
  // to actual stored document paths.
  async createSignedReadUrl(path: string): Promise<string> {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseKey) {
      throw new ServiceUnavailableException(
        'File uploads are not configured on this server (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).',
      );
    }
    const supabase = createClient(supabaseUrl, supabaseKey);
    const bucket = PURPOSE_CONFIG[UploadPurpose.IDENTITY_PROOF].bucket; // all three KYC purposes share one bucket
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 300);
    if (error) {
      throw new InternalServerErrorException(`Failed to create signed read URL: ${error.message}`);
    }
    return data.signedUrl;
  }
}
