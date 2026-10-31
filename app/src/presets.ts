/** Platform export presets: exact output sizes as the platforms currently specify them. */
export interface Preset {
  id: string;
  platform: string;
  label: string;
  width: number;
  height: number;
}

export const PRESETS: readonly Preset[] = [
  { id: "ig-square", platform: "Instagram", label: "Instagram post (square)", width: 1080, height: 1080 },
  { id: "ig-portrait", platform: "Instagram", label: "Instagram post (portrait)", width: 1080, height: 1350 },
  { id: "ig-story", platform: "Instagram", label: "Instagram story / Reel cover", width: 1080, height: 1920 },
  { id: "ig-landscape", platform: "Instagram", label: "Instagram post (landscape)", width: 1080, height: 566 },
  { id: "fb-post", platform: "Facebook", label: "Facebook link / post", width: 1200, height: 630 },
  { id: "x-post", platform: "X", label: "X post", width: 1600, height: 900 },
  { id: "x-header", platform: "X", label: "X header", width: 1500, height: 500 },
  { id: "li-post", platform: "LinkedIn", label: "LinkedIn post", width: 1200, height: 627 },
  { id: "yt-thumb", platform: "YouTube", label: "YouTube thumbnail", width: 1280, height: 720 },
  { id: "pin", platform: "Pinterest", label: "Pinterest pin", width: 1000, height: 1500 },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

export const FITS = ["cover", "contain"] as const;
export type Fit = (typeof FITS)[number];

export const EXPORT_FORMATS = ["png", "jpeg", "webp"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const DEFAULT_QUALITY = 82;
export const MIN_SEARCH_QUALITY = 30;
export const MAX_EXPORT_KB = 50_000;
