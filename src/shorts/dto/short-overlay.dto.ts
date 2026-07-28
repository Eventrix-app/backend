import { IsHexColor, IsIn, IsNumber, IsString, MaxLength, Min, Max } from 'class-validator';

// Font families the app actually registers in App.tsx's useFonts call. Constrained to an
// allow-list rather than accepting any string: this value is applied directly as a
// fontFamily when the feed renders someone else's reel, and an unbounded string from one
// client would be an arbitrary value injected into every other viewer's render path.
export const ALLOWED_OVERLAY_FONTS = [
  'ZalandoSansExpanded_700Bold',
  'ZalandoSansExpanded_900Black',
  'ZalandoSansExpanded_300Light',
  'Poppins_400Regular',
] as const;

/**
 * The text a creator positioned over their reel on the edit screen.
 *
 * Every geometric value is a *ratio* of the video's rendered size rather than a pixel
 * measurement, because the reel is composed on the uploader's phone and then rendered in
 * everyone else's feed at whatever size their device happens to be. Pixels would put the
 * text somewhere different — and at a different relative size — on every other screen.
 *
 * This is not burned into the video file. It is styling the app draws over the playing
 * video, so a reel downloaded from storage directly has no text on it. Compositing it into
 * the pixels would need a server-side FFmpeg pass.
 */
export class ShortOverlayDto {
  @IsString()
  @MaxLength(200)
  text!: string;

  // Hex only, so the value can be dropped straight into a color style without a client
  // being able to smuggle in something else that a style parser might accept.
  @IsHexColor()
  color!: string;

  @IsIn(ALLOWED_OVERLAY_FONTS as unknown as string[])
  fontFamily!: string;

  // Fraction of the video's width. Bounded well below 1 — a single glyph wider than the
  // frame is not a legitimate composition, and the cap keeps a hostile value from rendering
  // text large enough to cover a whole feed slide.
  @IsNumber()
  @Min(0.01)
  @Max(0.5)
  fontSizeRatio!: number;

  // Offsets from the layout's default caption position, as fractions of the video's width
  // and height. Allowed to exceed +/-1 slightly so text dragged partly off-frame keeps the
  // position the creator chose, but bounded so it cannot be parked arbitrarily far away.
  @IsNumber()
  @Min(-2)
  @Max(2)
  xRatio!: number;

  @IsNumber()
  @Min(-2)
  @Max(2)
  yRatio!: number;
}
