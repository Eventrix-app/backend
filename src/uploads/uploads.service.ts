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
// `event-images` also carries reel videos (UploadPurpose.REEL_VIDEO) and event gallery
// clips, which the 10MB photo limit rejected outright — no reel could ever be uploaded.
//
// 50MB, not more: a Supabase project has its own global file size limit that a bucket
// cannot exceed, and this project's is 50MB. Asking for anything above it makes
// updateBucket fail outright, which would leave the bucket on its previous (10MB) limit —
// so a larger number here does not mean larger uploads, it means no change at all.
//
// The client is held to the same ceiling from two directions so a user never records or
// picks a file that is guaranteed to be rejected: RecordReelScreen caps the recording with
// maxFileSize, and reelUploadManager checks the file before spending any upload bandwidth.
// If the project limit is ever raised, all three move together.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

// Per-bucket allow-list enforced by Supabase Storage itself on every upload through a
// signed URL, not just the DTO's client-declared contentType (which only ever chose a
// file extension for the object key — nothing previously stopped a client from PUTting
// arbitrary bytes, e.g. HTML/SVG with a mismatched Content-Type, to a "png" path). Only
// `event-images` needs video: it's shared by both EVENT_IMAGE (gallery items, which can be
// short video clips — see EventMedia.type) and EVENT_COVER (image-only in practice).
// Every other bucket here is inherently photo-only (profile pictures, logos, KYC document
// scans) and has no legitimate reason to accept video.
// The size limit is per-bucket rather than one global constant: only `event-images` accepts
// video, and holding it to the photo-sized limit silently broke every video upload.
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
  // true for KYC documents (identity/address proof, PAN/Aadhaar) — sensitive PII, not a
  // routinely-displayed public asset. createSignedUrl() skips getPublicUrl() for these and
  // returns the raw storage path instead; viewing one later requires a fresh short-lived
  // signed read URL (see createSignedReadUrl()), not a permanent public link.
  isPrivate?: boolean;
  // true rejects video/* content types even though the underlying bucket allows them —
  // `event-images` allows video because EVENT_IMAGE/REEL_VIDEO need it, but that bucket-
  // level allow-list is shared by every purpose stored there, so EVENT_COVER and
  // CATEGORY_ICON (image-only in practice) need their own, narrower check here.
  imageOnly?: boolean;
  // Purpose-specific ceiling, tighter than the bucket's own fileSizeLimit — only enforced
  // when the client sends CreateSignedUrlDto.fileSize (a UX-level guard, since the bucket's
  // own limit is what Storage actually enforces on the upload itself).
  maxBytes?: number;
}

const CATEGORY_ICON_MAX_BYTES = 2 * 1024 * 1024; // 2MB — matches the admin dashboard's own check

// Every purpose except the KYC ones below is a public bucket — low-sensitivity,
// routinely-displayed assets, so public buckets get the best CDN cache hit rate with no
// signed-URL complexity on the read side (multipart.md §3.3). Buckets are provisioned in
// Supabase out-of-band; this map only decides which bucket+prefix a purpose lands in.
const PURPOSE_CONFIG: Record<UploadPurpose, PurposeConfig> = {
  [UploadPurpose.PROFILE_PICTURE]: { bucket: 'profile-pictures', pathPrefix: 'users', allowedRoles: null },
  [UploadPurpose.EVENT_IMAGE]: { bucket: 'event-images', pathPrefix: 'events', allowedRoles: ['organizer', 'admin'] },
  [UploadPurpose.EVENT_COVER]: { bucket: 'event-images', pathPrefix: 'event-covers', allowedRoles: ['organizer', 'admin'], imageOnly: true },
  [UploadPurpose.COMPANY_LOGO]: { bucket: 'organizer-logos', pathPrefix: 'organizers', allowedRoles: ['organizer', 'admin'] },
  // allowedRoles: null — applicants aren't organizers yet at the point they submit these.
  [UploadPurpose.IDENTITY_PROOF]: { bucket: 'organizer-kyc-docs', pathPrefix: 'identity-proof', allowedRoles: null, isPrivate: true },
  [UploadPurpose.ADDRESS_PROOF]: { bucket: 'organizer-kyc-docs', pathPrefix: 'address-proof', allowedRoles: null, isPrivate: true },
  [UploadPurpose.PAN_OR_AADHAAR]: { bucket: 'organizer-kyc-docs', pathPrefix: 'pan-or-aadhaar', allowedRoles: null, isPrivate: true },
  // Reuses event-images (already public, already allows video/mp4 + video/quicktime) —
  // no new bucket to provision. allowedRoles: null since reel uploaders are attendees,
  // not organizers, unlike EVENT_IMAGE/EVENT_COVER above.
  [UploadPurpose.REEL_VIDEO]: { bucket: 'event-images', pathPrefix: 'reels', allowedRoles: null },
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

  // Self-healing, idempotent bucket-constraint sync — same spirit as CategoryService's
  // OnModuleInit seeding. Buckets themselves are still provisioned out-of-band in Supabase,
  // but their MIME/size limits are enforced from this map on every boot rather than only
  // living as a manually-set dashboard setting someone could forget to configure (or
  // accidentally loosen) on a new environment. Must never fail app startup — a missing
  // Supabase config or a not-yet-created bucket just logs a warning and skips.
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
        // Raised from warn to error: when this fails the bucket silently keeps whatever
        // limits it was provisioned with, and the only symptom is uploads being rejected by
        // Storage with a 400 that never mentions the bucket. That is far too quiet for a
        // misconfiguration that breaks a whole feature.
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

    if (config.imageOnly && dto.contentType.startsWith('video/')) {
      throw new BadRequestException(`Purpose "${dto.purpose}" does not accept video uploads`);
    }

    if (config.maxBytes && dto.fileSize && dto.fileSize > config.maxBytes) {
      throw new BadRequestException(`File exceeds the ${Math.round(config.maxBytes / (1024 * 1024))}MB limit for purpose "${dto.purpose}"`);
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
