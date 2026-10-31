/**
 * Generate the five stock images in public/stock/ (synthetic scenes, varied sizes,
 * aspects and formats). Run once; outputs are committed:
 *   node tools/make-stock-images.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp, { type Sharp } from "sharp";

const out = (name: string) => fileURLToPath(new URL(`../public/stock/${name}`, import.meta.url));

function svg(w: number, h: number, body: string): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`);
}

// 320x240 PNG: tiny thumbnail, sky + sun + hills
const thumb = svg(
  320,
  240,
  `
  <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dbeafe"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs>
  <rect width="320" height="240" fill="url(#s)"/>
  <circle cx="250" cy="70" r="30" fill="#f59e0b"/>
  <polygon points="0,240 0,150 90,90 170,170 230,120 320,190 320,240" fill="#4d7c0f"/>
  <polygon points="0,240 0,190 80,160 160,210 260,170 320,210 320,240" fill="#365314"/>`,
);

// 1600x1200 JPEG: "beach" photo with texture
const photo = svg(
  1600,
  1200,
  `
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#e0f2fe"/></linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0369a1"/><stop offset="1" stop-color="#38bdf8"/></linearGradient>
    <pattern id="waves" width="80" height="20" patternUnits="userSpaceOnUse"><path d="M0 10 Q20 0 40 10 T80 10" stroke="#ffffff" stroke-opacity="0.25" fill="none" stroke-width="3"/></pattern>
    <pattern id="sand" width="12" height="12" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.2" fill="#d9b982"/><circle cx="9" cy="8" r="1" fill="#e7cfa0"/></pattern>
  </defs>
  <rect width="1600" height="1200" fill="url(#sky)"/>
  <circle cx="1300" cy="220" r="90" fill="#fde047"/>
  <ellipse cx="400" cy="260" rx="220" ry="60" fill="#fff" fill-opacity="0.9"/><ellipse cx="520" cy="230" rx="160" ry="70" fill="#fff" fill-opacity="0.9"/>
  <rect y="560" width="1600" height="360" fill="url(#sea)"/><rect y="560" width="1600" height="360" fill="url(#waves)"/>
  <path d="M0 900 Q400 860 800 920 T1600 880 V1200 H0 Z" fill="#f3e4c0"/><path d="M0 900 Q400 860 800 920 T1600 880 V1200 H0 Z" fill="url(#sand)"/>
  <line x1="1150" y1="1120" x2="1150" y2="820" stroke="#78350f" stroke-width="10"/>
  <path d="M1000 840 Q1150 700 1300 840 Z" fill="#ef4444"/><path d="M1000 840 Q1075 770 1150 840 Z" fill="#fca5a5"/><path d="M1150 840 Q1225 770 1300 840 Z" fill="#fca5a5"/>
  <ellipse cx="1150" cy="1130" rx="120" ry="22" fill="#b45309" fill-opacity="0.3"/>`,
);

// 1920x1080 JPEG: night city skyline
const buildings = Array.from({ length: 28 }, (_, i) => {
  const x = i * 70,
    h = 250 + ((i * 137) % 500),
    w = 60;
  return `<rect x="${x}" y="${1080 - 120 - h}" width="${w}" height="${h}" fill="#1e293b"/><rect x="${x}" y="${1080 - 120 - h}" width="${w}" height="${h}" fill="url(#win)"/>`;
}).join("");
const fhd = svg(
  1920,
  1080,
  `
  <defs>
    <linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#312e81"/></linearGradient>
    <pattern id="win" width="14" height="18" patternUnits="userSpaceOnUse"><rect x="3" y="4" width="6" height="8" fill="#fde68a" fill-opacity="0.8"/></pattern>
  </defs>
  <rect width="1920" height="1080" fill="url(#night)"/>
  <circle cx="1600" cy="200" r="80" fill="#f1f5f9"/><circle cx="1570" cy="180" r="70" fill="#1a2348" fill-opacity="0.9"/>
  ${Array.from({ length: 120 }, (_, i) => `<circle cx="${(i * 397) % 1920}" cy="${(i * 211) % 500}" r="${1 + (i % 3)}" fill="#fff" fill-opacity="0.8"/>`).join("")}
  ${buildings}
  <rect y="960" width="1920" height="120" fill="#0b1020"/>
  <rect y="965" width="1920" height="110" fill="url(#night)" opacity="0.5"/>`,
);

// 1080x1920 WebP: tall forest with a path
const trees = Array.from({ length: 14 }, (_, i) => {
  const x = (i * 173) % 1080,
    y = 700 + ((i * 97) % 600),
    s = 0.6 + (i % 4) * 0.25;
  return `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-12" y="0" width="24" height="120" fill="#7c2d12"/><polygon points="-110,0 0,-220 110,0" fill="#166534"/><polygon points="-90,-90 0,-280 90,-90" fill="#15803d"/><polygon points="-70,-170 0,-330 70,-170" fill="#22c55e"/></g>`;
}).join("");
const portrait = svg(
  1080,
  1920,
  `
  <defs><linearGradient id="d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fef3c7"/><stop offset="0.5" stop-color="#fbcfe8"/><stop offset="1" stop-color="#c7d2fe"/></linearGradient></defs>
  <rect width="1080" height="1920" fill="url(#d)"/>
  <circle cx="540" cy="420" r="150" fill="#fb923c" fill-opacity="0.9"/>
  <rect y="700" width="1080" height="1220" fill="#365314"/>
  <path d="M420 1920 Q540 1400 600 1100 Q660 1400 700 1920 Z" fill="#d6d3d1"/>
  ${trees}`,
);

// 4000x1000 PNG: wide mountain range
const peaks = (n: number, base: number, amp: number, seed: number, fill: string) => {
  const pts = Array.from({ length: n + 1 }, (_, i) => `${(i * 4000) / n},${base - ((i * seed) % amp)}`).join(" ");
  return `<polygon points="0,1000 ${pts} 4000,1000" fill="${fill}"/>`;
};
const panorama = svg(
  4000,
  1000,
  `
  <defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#f472b6"/></linearGradient></defs>
  <rect width="4000" height="1000" fill="url(#p)"/>
  <circle cx="3300" cy="300" r="110" fill="#fde68a"/>
  ${peaks(20, 620, 380, 191, "#6d28d9")}${peaks(28, 720, 300, 233, "#4c1d95")}${peaks(40, 850, 220, 97, "#2e1065")}
  <rect y="930" width="4000" height="70" fill="#1e1b4b"/>`,
);

const jobs: Array<[string, Buffer, (s: Sharp) => Sharp]> = [
  ["thumb.png", thumb, (s) => s.png({ compressionLevel: 9 })],
  ["photo.jpg", photo, (s) => s.jpeg({ quality: 82 })],
  ["fhd.jpg", fhd, (s) => s.jpeg({ quality: 80 })],
  ["portrait.webp", portrait, (s) => s.webp({ quality: 80 })],
  ["panorama.png", panorama, (s) => s.png({ compressionLevel: 9, palette: true })],
];
for (const [name, input, encode] of jobs) {
  const buf = await encode(sharp(input)).toBuffer();
  writeFileSync(out(name), buf);
  const m = await sharp(buf).metadata();
  console.log(`${name.padEnd(14)} ${m.width}x${m.height} ${m.format} ${(buf.length / 1024).toFixed(0)} KB`);
}
