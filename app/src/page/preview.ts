/**
 * Preview chrome (spec 4d): the Desktop / Mobile switch, the device frame with its controls,
 * and the guides overlay drawn over the desktop preview. All links are plain URLs: state lives
 * in the query string.
 */

import { ICON } from "../android.ts";
import { cellRects, type Gutter, type Layout } from "../collage.ts";
import { DEVICES, type Device, neighbours, viewportFor } from "../devices.ts";
import { type Size, thumbSize } from "../geometry.ts";
import { escapeHtml } from "../markdown.ts";
import { type AndroidMode, FEED_WIDTH, FRAME_MAX, type PreviewState, ROW_SIZES, THEMES, TILE_SIZES, type View } from "../params.ts";
import { raw, type Safe } from "./html.ts";

/** Build a page URL from the current image settings plus page-level overrides. */
export function pageUrl(settings: URLSearchParams, overrides: Record<string, string | undefined>): string {
  const q = new URLSearchParams(settings);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) q.delete(key);
    else q.set(key, value);
  }
  const query = q.toString();
  return query ? `/?${query}` : "/";
}

/** Header: the Desktop / Mobile segmented switch. Both links keep the chosen device/orientation. */
export function renderModeSwitch(settings: URLSearchParams, state: PreviewState): Safe {
  const { view, device, orientation } = state;
  const tab = (v: View, label: string) =>
    `<a class="${view === v ? "active" : ""}" href="${escapeHtml(pageUrl(settings, { view: v === "desktop" ? undefined : v, device: device.slug, orientation }))}"${view === v ? ' aria-current="page"' : ""}>${label}</a>`;
  return raw(`<nav class="mode-switch" aria-label="Preview mode">${tab("desktop", "Desktop")}${tab("mobile", "Mobile")}${tab("context", "In context")}</nav>`);
}

/** Under the device frame: prev / caption / next, orientation toggle, and one chip per device. */
function renderDeviceControls(settings: URLSearchParams, state: PreviewState): string {
  const { device, orientation } = state;
  const { prev, next } = neighbours(device);
  const deviceHref = (d: Device) => escapeHtml(pageUrl(settings, { view: "mobile", device: d.slug, orientation }));
  const { width, height } = viewportFor(device, orientation);
  const chip = (d: Device) =>
    `<a class="chip${d === device ? " active" : ""}" href="${deviceHref(d)}" title="${escapeHtml(`${d.name} - ${d.width}x${d.height} @${d.dpr}x`)}"${d === device ? ' aria-current="true"' : ""}>${escapeHtml(d.name)}</a>`;
  const group = (platform: Device["platform"]) =>
    `<span class="platform">${platform}</span>${DEVICES.filter((d) => d.platform === platform)
      .map(chip)
      .join("")}`;
  const flip = orientation === "portrait" ? "landscape" : "portrait";
  return `<div class="device-controls">
          <a class="nav" href="${deviceHref(prev)}" rel="prev" aria-label="Previous device: ${escapeHtml(prev.name)}">&#8249; Prev</a>
          <span class="device-caption"><strong>${escapeHtml(device.name)}</strong> &middot; ${width}&times;${height} &middot; @${device.dpr}x &middot; ${device.platform} &middot; ${orientation}</span>
          <a class="nav" href="${deviceHref(next)}" rel="next" aria-label="Next device: ${escapeHtml(next.name)}">Next &#8250;</a>
          <a class="orientation" href="${escapeHtml(pageUrl(settings, { view: "mobile", device: device.slug, orientation: flip }))}">Rotate to ${flip}</a>
        </div>
        <div class="device-chips">${group("iOS")}${group("Android")}</div>`;
}

/**
 * The device frame showing only the watermarked image, scaled to fit FRAME_MAX, with the
 * device controls underneath. `imageSettings` must be the final, validated image query
 * (after traverse "keep"), so the frame shows exactly what the outer page's toasts describe.
 */
export function renderDeviceFrame(settings: URLSearchParams, imageSettings: URLSearchParams, state: PreviewState): Safe {
  const { width, height } = viewportFor(state.device, state.orientation);
  const scale = Math.min(1, FRAME_MAX.width / width, FRAME_MAX.height / height);
  const src = escapeHtml(pageUrl(imageSettings, { embed: "image" }));
  // Guides: system bars in dp (= CSS px), drawn over the frame, never part of the image.
  let guides = "";
  if (state.guides) {
    const portrait = state.orientation === "portrait";
    const cut = state.device.cutout;
    const cutout =
      !portrait || !cut
        ? ""
        : cut === "notch"
          ? `<div class="guide cutout notch" title="Display cutout (notch)"></div>`
          : cut === "pill"
            ? `<div class="guide cutout pill" title="Display cutout (Dynamic Island)"></div>`
            : `<div class="guide cutout punch" title="Display cutout (punch-hole camera)"></div>`;
    guides = `<div class="guides" aria-hidden="true">
              <div class="guide status" title="Status bar - 24 dp"></div>${cutout}
              <div class="guide nav${portrait ? "" : " landscape"}" title="Navigation bar - 48 dp"></div>
            </div>`;
  }
  return raw(`<section class="device-preview" aria-label="Mobile preview">
        <div class="device-frame-box" style="width:${Math.round(width * scale)}px;height:${Math.round(height * scale)}px">
          <div class="device-frame ${state.orientation}" style="width:${width}px;height:${height}px;transform:scale(${scale.toFixed(4)})">
            <iframe title="${escapeHtml(state.device.name)} preview" src="${src}" width="${width}" height="${height}"></iframe>${guides}
          </div>
        </div>
        ${renderDeviceControls(settings, state)}
        <p class="device-note">${width}&times;${height} CSS px${scale < 1 ? ` &middot; shown at ${Math.round(scale * 100)}%` : ""} &middot; <a href="${src}" target="_blank" rel="noopener">open this view in a new tab</a></p>
      </section>`);
}

/** Guides over the desktop preview: icon safe zones (icon mode) or story keep-clear bands. */
export function renderPreviewOverlay(
  state: PreviewState,
  androidMode: AndroidMode,
  presetId?: string,
  collage?: { options: { layout: Layout; gutter: Gutter; cells: Array<string | null> }; canvas: Size; gutterPx: number },
): { overlay: Safe; legend: Safe } {
  if (!state.guides || state.view !== "desktop" || state.embed) return { overlay: raw(""), legend: raw("") };
  if (collage && androidMode !== "icon") {
    // Numbered cell outlines, in percentages of the canvas so they scale with the preview.
    const rects = cellRects(collage.options.layout, collage.canvas, collage.gutterPx);
    const pct = (v: number, total: number) => ((v / total) * 100).toFixed(2);
    const cells = rects
      .map(
        (r, i) =>
          `<rect class="cell-guide" x="${pct(r.left, collage.canvas.width)}" y="${pct(r.top, collage.canvas.height)}" width="${pct(r.width, collage.canvas.width)}" height="${pct(r.height, collage.canvas.height)}"/>` +
          `<text class="cell-guide-label" x="${pct(r.left + 8, collage.canvas.width)}" y="${pct(r.top + 8, collage.canvas.height)}" dominant-baseline="hanging">${i + 1}</text>` +
          (collage.options.cells[i] === null
            ? `<text class="cell-guide-empty" x="${pct(r.left + r.width / 2, collage.canvas.width)}" y="${pct(r.top + r.height / 2, collage.canvas.height)}" dominant-baseline="middle">empty</text>`
            : ""),
      )
      .join("");
    return {
      overlay: raw(`<svg class="overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${cells}</svg>`),
      legend: raw(`<p class="overlay-legend">Guides: dashed outlines are the template's cells (numbered like the pickers below)</p>`),
    };
  }
  if (androidMode === "icon") {
    // The preview shows the visible 72 dp; the 66 dp safe zone is a centred circle of 66/72 of the width.
    const safe = (ICON.safeDp / ICON.visibleDp) * 50;
    const svg = `<svg class="overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <circle cx="50" cy="50" r="49.5" fill="none" stroke="#0f766e" stroke-width="0.6" stroke-dasharray="2 1.5"/>
          <circle cx="50" cy="50" r="${safe.toFixed(2)}" fill="none" stroke="#d97706" stroke-width="0.8"/>
          <path d="M0 0H100V100H0Z M50 ${50 - 49.5} A49.5 49.5 0 1 0 50 ${50 + 49.5} A49.5 49.5 0 1 0 50 ${50 - 49.5}Z" fill="#000" fill-opacity="0.35" fill-rule="evenodd"/>
        </svg>`;
    return {
      overlay: raw(svg),
      legend: raw(
        `<p class="overlay-legend">Guides: <span class="swatch teal"></span> 72 dp visible circle (masked by launchers) &middot; <span class="swatch amber"></span> 66 dp safe zone</p>`,
      ),
    };
  }
  if (presetId === "ig-story") {
    const band = ((250 / 1920) * 100).toFixed(2);
    return {
      overlay: raw(
        `<div class="overlay band top" style="height:${band}%" title="Keep clear: top 250 px (profile, progress bar)"></div><div class="overlay band bottom" style="height:${band}%" title="Keep clear: bottom 250 px (reply bar)"></div>`,
      ),
      legend: raw(`<p class="overlay-legend">Guides: keep text and logos out of the top and bottom 250 px of a story</p>`),
    };
  }
  return {
    overlay: raw(""),
    legend: raw(`<p class="overlay-legend">Guides: select a device in Mobile view, the Icon mode, or the Instagram story preset to see safe areas</p>`),
  };
}

// ---------------------------------------------------------------------------
// In context (4.9): grid / list / feed scenes with stock neighbours

const STOCK_ORDER = ["photo", "fhd", "portrait", "panorama", "sample", "thumb"] as const;

/** Neighbour image ids: the stock set in a fixed order, skipping the selected image (a collage uses all). */
export function neighbourIds(selected: string | null, count: number): string[] {
  const pool = STOCK_ORDER.filter((id) => id !== selected);
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]!);
}

export interface SceneInput {
  state: PreviewState;
  /** The validated image query (ours); empty when the render is invalid. */
  imageQuery: URLSearchParams;
  /** Settings the chips carry along. */
  settings: URLSearchParams;
  /** Selected image id (null for a collage). */
  selectedId: string | null;
  /** Preset + fit the neighbours should share (so shapes match). */
  presetId?: string;
  fit?: string;
  output?: Size;
  /** Traverse values that move the mark into the thumbnail-safe square (shown as a fix chip). */
  thumbnailFix?: { traverseX: number; traverseY: number };
}

const withThumb = (query: URLSearchParams, thumb: string) => {
  const q = new URLSearchParams(query);
  q.set("thumb", thumb);
  return `/image?${q.toString()}`;
};
const neighbourUrl = (id: string, input: SceneInput, thumb: string) => {
  const q = new URLSearchParams({ image: id });
  if (input.presetId) q.set("preset", input.presetId);
  if (input.presetId && input.fit && input.fit !== "cover") q.set("fit", input.fit);
  return withThumb(q, thumb);
};

function sceneChips(input: SceneInput): string {
  const { state, settings } = input;
  const link = (label: string, overrides: Record<string, string | undefined>, active: boolean) =>
    `<a class="chip${active ? " active" : ""}" href="${escapeHtml(pageUrl(settings, { view: "context", scene: state.scene, tile: String(state.tile), row: String(state.row), theme: state.theme, frame: state.frame ? "1" : undefined, device: state.frame ? state.device.slug : undefined, ...overrides }))}"${active ? ' aria-current="true"' : ""}>${escapeHtml(label)}</a>`;
  const scenes = [
    ["grid", "Grid"],
    ["list", "List"],
    ["feed", "Feed"],
  ]
    .map(([id, label]) => link(label!, { scene: id }, state.scene === id))
    .join("");
  const sizes =
    state.scene === "grid"
      ? TILE_SIZES.map((t) => link(String(t), { tile: String(t) }, state.tile === t)).join("")
      : state.scene === "list"
        ? ROW_SIZES.map((r) => link(String(r), { row: String(r) }, state.row === r)).join("")
        : "";
  const themes = THEMES.map((t) => link(t === "light" ? "Light" : "Dark", { theme: t }, state.theme === t)).join("");
  const where =
    state.scene === "feed"
      ? `<span class="platform">Where</span>${link("Desktop column", { frame: undefined }, !state.frame)}${link("On a phone", { frame: "1" }, state.frame)}`
      : "";
  const devices =
    state.scene === "feed" && state.frame
      ? `<span class="platform">Device</span>${DEVICES.map((d) => link(d.name, { frame: "1", device: d.slug }, d === state.device)).join("")}`
      : "";
  const fix = input.thumbnailFix
    ? `<span class="platform">Fix</span><a class="chip fix" href="${escapeHtml(pageUrl(settings, { view: "context", scene: state.scene, tile: String(state.tile), row: String(state.row), theme: state.theme, frame: state.frame ? "1" : undefined, device: state.frame ? state.device.slug : undefined, traverseX: String(input.thumbnailFix.traverseX), traverseY: String(input.thumbnailFix.traverseY) }))}" title="Sets traverseX/Y so the mark sits inside the centre square that gallery and list crops keep">Move the watermark into the thumbnail-safe area</a>`
    : "";
  return `<div class="device-chips scene-chips"><span class="platform">Scene</span>${scenes}${sizes ? `<span class="platform">Size</span>${sizes}` : ""}<span class="platform">Theme</span>${themes}${where}${devices}${fix}</div>`;
}

/** The in-context scene (4.9). `embedOnly` renders just the scene (for the device frame). */
export function renderScene(input: SceneInput, embedOnly = false): Safe {
  const { state } = input;
  const guided = state.guides;
  const ours = (thumb: string) => withThumb(input.imageQuery, thumb);
  let body: string;
  if (state.scene === "grid") {
    const t = state.tile,
      thumb = `${t}x${t}`;
    const ids = neighbourIds(input.selectedId, 8);
    const tiles = Array.from({ length: 9 }, (_, i) => {
      const isOurs = i === 4;
      const src = isOurs ? ours(thumb) : neighbourUrl(ids[i < 4 ? i : i - 1]!, input, thumb);
      const img = `<img class="tile${isOurs ? " ours" : ""}" src="${escapeHtml(src)}" width="${t}" height="${t}" alt="${isOurs ? "your image as a gallery tile" : "sample tile"}">`;
      return isOurs && guided
        ? `<figure class="tile-box ours guided">${img}<figcaption class="scene-size">${t}&times;${t} px</figcaption></figure>`
        : `<div class="tile-box${isOurs ? " ours" : ""}">${img}</div>`;
    }).join("");
    body = `<div class="grid-tiles" style="--tile:${t}px">${tiles}</div>`;
  } else if (state.scene === "list") {
    const r = state.row,
      thumb = `${r}x${r}`;
    const ids = neighbourIds(input.selectedId, 4);
    const titles = ["Weekend market finds", "Notes from the trail", "Your image", "Studio session", "City after dark"];
    const rows = Array.from({ length: 5 }, (_, i) => {
      const isOurs = i === 2;
      const src = isOurs ? ours(thumb) : neighbourUrl(ids[i < 2 ? i : i - 1]!, input, thumb);
      const size = isOurs && guided ? `<span class="scene-size">${r}&times;${r} px</span>` : "";
      return `<li class="row${isOurs ? " ours" : ""}${isOurs && guided ? " guided" : ""}"><img src="${escapeHtml(src)}" width="${r}" height="${r}" alt="${isOurs ? "your image as a list thumbnail" : "sample thumbnail"}"><div class="row-text"><strong>${titles[i]}</strong><span>${isOurs ? "Posted just now" : "Posted 2 days ago"} &middot; 12 comments</span>${size}</div></li>`;
    }).join("");
    body = `<ul class="list-rows" style="--row:${r}px">${rows}</ul>`;
  } else {
    body = renderFeed(input);
  }
  const scene = `<section class="scene scene-${state.scene} ${state.theme}" data-scene="${state.scene}" aria-label="In-context preview">${body}</section>`;
  if (embedOnly) return raw(scene);
  if (state.scene === "feed" && state.frame) {
    // The feed inside the device frame: the iframe shows the scene-only page at the device's viewport.
    const { width, height } = viewportFor(state.device, state.orientation);
    const scale = Math.min(1, FRAME_MAX.width / width, FRAME_MAX.height / height);
    const src = escapeHtml(
      pageUrl(input.imageQuery, {
        view: "context",
        scene: "feed",
        theme: state.theme,
        device: state.device.slug,
        orientation: state.orientation,
        embed: "scene",
      }),
    );
    const frame = `<div class="device-frame-box" style="width:${Math.round(width * scale)}px;height:${Math.round(height * scale)}px">
          <div class="device-frame ${state.orientation}" style="width:${width}px;height:${height}px;transform:scale(${scale.toFixed(4)})">
            <iframe title="${escapeHtml(state.device.name)} feed preview" src="${src}" width="${width}" height="${height}"></iframe>
          </div>
        </div>
        <p class="device-note"><strong>${escapeHtml(state.device.name)}</strong> &middot; ${width}&times;${height} CSS px${scale < 1 ? ` &middot; shown at ${Math.round(scale * 100)}%` : ""} &middot; <a href="${src}" target="_blank" rel="noopener">open this view in a new tab</a></p>`;
    return raw(`<div class="context-preview">${frame}${sceneChips(input)}</div>`);
  }
  return raw(`<div class="context-preview">${scene}${sceneChips(input)}</div>`);
}

/** Feed scene (phase B). */
function renderFeed(input: SceneInput): string {
  // Inside the device frame the feed is as wide as the phone: render at that width, not the desktop column's.
  const feedWidth = input.state.embed === "scene" ? viewportFor(input.state.device, input.state.orientation).width : FEED_WIDTH;
  const thumb = `${feedWidth}x`;
  const ids = neighbourIds(input.selectedId, 2);
  const posts = [
    { id: ids[0]!, name: "maya.k", caption: "Golden hour at the pier" },
    { id: null, name: "you", caption: "Your post" },
    { id: ids[1]!, name: "theo_builds", caption: "Weekend project, finally done" },
  ];
  const size = (id: string | null) => {
    if (id !== null || !input.output) return "";
    const s = thumbSize(input.output, { fit: "width", width: feedWidth });
    return ` width="${s.width}" height="${s.height}"`;
  };
  return `<div class="feed" style="--feed:${feedWidth}px">${posts
    .map((p) => {
      const isOurs = p.id === null;
      const src = isOurs ? withThumb(input.imageQuery, thumb) : neighbourUrl(p.id!, input, thumb);
      const guided =
        isOurs && input.state.guides && input.output
          ? `<figcaption class="scene-size">${thumbSize(input.output, { fit: "width", width: FEED_WIDTH }).width}&times;${thumbSize(input.output, { fit: "width", width: FEED_WIDTH }).height} px</figcaption>`
          : "";
      return `<article class="post${isOurs ? " ours" : ""}${isOurs && input.state.guides ? " guided" : ""}"><header><span class="avatar"></span><strong>${p.name}</strong><span class="dot">&middot;</span><span>${isOurs ? "now" : "3h"}</span></header><figure><img src="${escapeHtml(src)}"${size(p.id)} alt="${isOurs ? "your image as a feed post" : "sample post"}">${guided}</figure><div class="actions-row"><span>&#9825; ${isOurs ? "0" : "1,204"}</span><span>&#9675; ${isOurs ? "0" : "37"}</span><span>&#8599;</span></div><p><strong>${p.name}</strong> ${p.caption}</p></article>`;
    })
    .join("")}</div>`;
}
