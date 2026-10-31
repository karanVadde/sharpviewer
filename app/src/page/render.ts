/**
 * The viewer page (spec 4g): one PageContext per request, then each card contributes its
 * template values, then public/index.html is filled. Strings are escaped on insertion; only
 * `Safe` fragments (built from escaped pieces) are inserted as markup.
 */

import { androidCard, chrome, collageCard, enhanceCard, exportCard, hiddenFields, imageCard, outputCard, type Values, watermarkCard } from "./cards.ts";
import { buildPageContext, type ViewerPageExtras } from "./context.ts";
import { fill, stripBlock } from "./html.ts";
import { renderDeviceFrame, renderModeSwitch, renderPreviewOverlay, renderScene } from "./preview.ts";

export type { PageContext, ViewerPageExtras } from "./context.ts";
export { buildPageContext } from "./context.ts";
export { pageUrl } from "./preview.ts";

/**
 * Fill the viewer page template: the <img src> gets the validated query forwarded, the form
 * fields echo the current values, and an invalid query shows its message instead of a broken image.
 */
export async function renderViewerPage(template: string, params: URLSearchParams, extras: ViewerPageExtras = {}): Promise<string> {
  const ctx = await buildPageContext(params, extras);
  const { state, forwarded, imageQuery, error, mobile, context, androidMode, exportInfo, passthrough } = ctx;
  const passthroughHidden = hiddenFields(passthrough);

  // In context (4.9): the preview card shows the scene (grid / list / feed) instead of the image.
  const sceneInput = {
    state,
    imageQuery: error ? new URLSearchParams() : imageQuery,
    settings: forwarded,
    selectedId: ctx.collage ? null : ctx.selectedImage.id,
    presetId: exportInfo?.preset?.id,
    fit: exportInfo?.fit,
    output: ctx.output,
    thumbnailFix: ctx.thumbnailFix,
  };
  const showScene = context || state.embed === "scene";
  const alternatePreview = showScene
    ? renderScene(sceneInput, state.embed === "scene")
    : mobile
      ? renderDeviceFrame(forwarded, error ? new URLSearchParams() : imageQuery, state)
      : "";

  const values: Values = {
    ...chrome(ctx, renderPreviewOverlay(state, androidMode, exportInfo?.preset?.id, ctx.collage), renderModeSwitch(forwarded, state), alternatePreview),
    ...(await imageCard(ctx, passthroughHidden)),
    ...watermarkCard(ctx, passthroughHidden),
    ...enhanceCard(ctx),
    ...outputCard(ctx),
    ...exportCard(ctx),
    ...androidCard(ctx),
    ...(await collageCard(ctx)),
  };

  // Mobile view: the image is shown inside the device frame instead of directly.
  // embed=image: only the image, no header/form/banner/toasts.
  let html = template;
  if (mobile || showScene) html = stripBlock(html, "image");
  if (state.embed) {
    html = stripBlock(stripBlock(stripBlock(html, "header"), "controls"), "script");
    values.ERROR = "";
    values.TOASTS = "";
  }
  return fill(html, values);
}
