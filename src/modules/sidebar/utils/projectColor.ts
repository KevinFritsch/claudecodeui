/**
 * Project colours for the sidebar: a stable default derived from the project
 * name, plus helpers to validate and tint a chosen colour.
 */

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** True for a `#rrggbb` colour, the only form stored as a project colour. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value);
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = hue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const [r, g, b] =
    segment < 1 ? [chroma, secondary, 0]
      : segment < 2 ? [secondary, chroma, 0]
        : segment < 3 ? [0, chroma, secondary]
          : segment < 4 ? [0, secondary, chroma]
            : segment < 5 ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const offset = l - chroma / 2;
  const toHex = (channel: number) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Turns any text into a colour in `#rrggbb`, the same colour every time for
 * the same text. Only the hue varies (FNV-1a hash of the lower-cased text), so
 * every project colour has the same brightness and reads well on dark and
 * light backgrounds alike.
 */
export function colorFromText(text: string): string {
  let hash = 0x811c9dc5;
  for (const character of text.trim().toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hslToHex(hash % 360, 65, 60);
}

/** `#rrggbb` plus an opacity, as an `rgba()` string for tinted backgrounds and borders. */
export function withAlpha(hexColor: string, alpha: number): string {
  const value = Number.parseInt(hexColor.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
