import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../common/cache/cache.service';

export interface ReverseGeocodeResult {
  address: string | null;
}

// A coordinate's street address does not meaningfully change, so this is cached for a week
// rather than minutes. The ceiling on staleness is Google re-mapping a building, which is not
// a correctness concern for prefilling a venue field.
const GEOCODE_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

// Coordinates are cached rounded to 4 decimal places (~11m). Raw GPS fixes and map-drag
// coordinates carry far more precision than that and effectively never repeat, so keying on
// them verbatim would produce a cache that never hits. 11m is finer than any address this is
// used to resolve, so rounding cannot return a neighbouring building's address.
const GEOCODE_PRECISION = 4;

function geocodeCacheKey(lat: number, lng: number): string {
  return `geocode:rev:${lat.toFixed(GEOCODE_PRECISION)},${lng.toFixed(GEOCODE_PRECISION)}`;
}

// Proxies Google's Geocoding API server-side so the key never ships in the app bundle —
// LocationPickerModal calls GET /geocode/reverse instead of Google directly (see
// task.md #3's "Google Maps API for pin-drop + geocoding" decision).
@Injectable()
export class GeocodeService {
  private readonly logger = new Logger(GeocodeService.name);
  private readonly apiKey?: string;

  constructor(
    configService: ConfigService,
    private readonly cache: CacheService,
  ) {
    this.apiKey = configService.get<string>('googleMaps.apiKey');
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  async reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
    if (!this.apiKey) {
      // Fails loudly rather than the EmailService/PushService no-op pattern — a caller
      // actively awaiting this result (the map picker) needs to know geocoding isn't set
      // up, not silently get back a blank address forever.
      throw new ServiceUnavailableException('Geocoding is not configured');
    }

    // Checked before the network call because every miss here is a billed Google request,
    // not just a slow one — the same handful of coordinates recur constantly (each app
    // foreground, each return to the same map position).
    const cacheKey = geocodeCacheKey(lat, lng);
    const cached = await this.cache.get<ReverseGeocodeResult>(cacheKey);
    if (cached) return cached;

    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${this.apiKey}`;
    try {
      // Without a timeout, Google's endpoint simply hanging (no response, no error) would
      // leave this request open indefinitely instead of failing — the catch block below
      // only handles a genuine network error or non-OK status, not a stall.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      const data = await res.json();
      if (data.status !== 'OK' || !data.results?.length) {
        // A pin over open water / no addressable result is a normal outcome, not an
        // error — the picker still works with just coordinates, it just has no address
        // to prefill venueAddress with.
        if (data.status !== 'ZERO_RESULTS') {
          this.logger.warn(`Google Geocoding API returned status=${data.status} for ${lat},${lng}`);
        }
        // ZERO_RESULTS is cached; a transient failure (REQUEST_DENIED, OVER_QUERY_LIMIT) is
        // not. Both return the same empty shape to the caller, but caching a key or quota
        // problem would keep serving a blank address long after it was fixed.
        const empty: ReverseGeocodeResult = { address: null };
        if (data.status === 'ZERO_RESULTS') {
          await this.cache.set(cacheKey, empty, GEOCODE_CACHE_TTL_SECONDS);
        }
        return empty;
      }
      const result: ReverseGeocodeResult = { address: data.results[0].formatted_address ?? null };
      await this.cache.set(cacheKey, result, GEOCODE_CACHE_TTL_SECONDS);
      return result;
    } catch (err) {
      this.logger.error(`Reverse geocode failed for ${lat},${lng}: ${err instanceof Error ? err.message : String(err)}`);
      return { address: null };
    }
  }
}
