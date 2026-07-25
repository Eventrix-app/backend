import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ReverseGeocodeResult {
  address: string | null;
}

// Proxies Google's Geocoding API server-side so the key never ships in the app bundle —
// LocationPickerModal calls GET /geocode/reverse instead of Google directly (see
// task.md #3's "Google Maps API for pin-drop + geocoding" decision).
@Injectable()
export class GeocodeService {
  private readonly logger = new Logger(GeocodeService.name);
  private readonly apiKey?: string;

  constructor(configService: ConfigService) {
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
        return { address: null };
      }
      return { address: data.results[0].formatted_address ?? null };
    } catch (err) {
      this.logger.error(`Reverse geocode failed for ${lat},${lng}: ${err instanceof Error ? err.message : String(err)}`);
      return { address: null };
    }
  }
}
