/**
 * Device profiles for the Mobile preview (CSS viewport in portrait, device pixel ratio).
 * Sizes match Playwright's device descriptors so the optional browser test can emulate
 * exactly what the in-page preview shows.
 */
export type Platform = "iOS" | "Android";
export type Orientation = "portrait" | "landscape";

export interface Device {
  slug: string;
  name: string;
  platform: Platform;
  width: number;
  height: number;
  dpr: number;
  /** Display cutout, for the guides overlay: a notch / Dynamic Island pill, or a punch-hole camera. */
  cutout?: "notch" | "pill" | "punch";
}

export const DEVICES: readonly Device[] = [
  { slug: "iphone-se", name: "iPhone SE", platform: "iOS", width: 320, height: 568, dpr: 2 },
  { slug: "iphone-13", name: "iPhone 13", platform: "iOS", width: 390, height: 664, dpr: 3, cutout: "notch" },
  { slug: "iphone-14-pro-max", name: "iPhone 14 Pro Max", platform: "iOS", width: 430, height: 740, dpr: 3, cutout: "pill" },
  { slug: "ipad-mini", name: "iPad Mini", platform: "iOS", width: 768, height: 1024, dpr: 2 },
  { slug: "ipad-pro-11", name: "iPad Pro 11", platform: "iOS", width: 834, height: 1194, dpr: 2 },
  { slug: "galaxy-s9-plus", name: "Galaxy S9+", platform: "Android", width: 320, height: 658, dpr: 4.5 },
  { slug: "galaxy-s24", name: "Galaxy S24", platform: "Android", width: 360, height: 780, dpr: 3, cutout: "punch" },
  { slug: "pixel-5", name: "Pixel 5", platform: "Android", width: 393, height: 727, dpr: 2.75, cutout: "punch" },
  { slug: "pixel-7", name: "Pixel 7", platform: "Android", width: 412, height: 839, dpr: 2.625, cutout: "punch" },
  { slug: "galaxy-tab-s4", name: "Galaxy Tab S4", platform: "Android", width: 712, height: 1138, dpr: 2.25 },
];

export const ORIENTATIONS: readonly Orientation[] = ["portrait", "landscape"];

export function findDevice(slug: string): Device | undefined {
  return DEVICES.find((device) => device.slug === slug);
}

/** Viewport size for a device in the given orientation. */
export function viewportFor(device: Device, orientation: Orientation): { width: number; height: number } {
  return orientation === "landscape" ? { width: device.height, height: device.width } : { width: device.width, height: device.height };
}

/** Neighbours in the list, wrapping around at both ends. */
export function neighbours(device: Device): { prev: Device; next: Device } {
  const index = DEVICES.indexOf(device);
  return {
    prev: DEVICES[(index - 1 + DEVICES.length) % DEVICES.length]!,
    next: DEVICES[(index + 1) % DEVICES.length]!,
  };
}
