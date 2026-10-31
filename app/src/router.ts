/**
 * HTTP layer: createApp() routes requests to the page, the image pipeline, exports, Android
 * assets and the docs; parses POST bodies (watermark text, uploads); maps BadRequestError to 400.
 */
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer, type Server } from "node:http";
import { renderAndroidZip, renderIconComposite } from "./android-zip.ts";
import { DOCS, renderDocPage } from "./docs.ts";
import { BadRequestError } from "./errors.ts";
import { MAX_UPLOAD_BYTES, removeUpload, saveUpload } from "./images.ts";
import { ServiceUnavailableError, withRenderSlot } from "./limits.ts";
import { pageUrl, renderViewerPage } from "./page/render.ts";
import { PASSTHROUGH_PARAMS, parseAndroidOptions, parseExportOptions, parseImageOptions } from "./params.ts";
import { renderExport, renderImage } from "./pipeline.ts";
import { restoreStockWatermark, setCustomWatermarkText } from "./watermark.ts";

const pagePath = new URL("../public/index.html", import.meta.url);

/** Headers every response gets (A11). */
const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;

/**
 * Content-Security-Policy for HTML responses: scripts only with this response's nonce (the page
 * has one inline script), styles inline (the template's stylesheet and the device frame's sizes),
 * everything else same-origin. The device frame iframes the page itself (frame-ancestors 'self').
 */
function htmlHeaders(nonce: string): Record<string, string> {
  return {
    ...BASE_HEADERS,
    "Content-Security-Policy": [
      "default-src 'self'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "frame-src 'self'",
      "frame-ancestors 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join("; "),
  };
}

const newNonce = () => randomBytes(16).toString("base64url");

/** The page template, re-read only when public/index.html changes (A3). */
let templateCache: { key: string; text: string } | undefined;
async function pageTemplate(): Promise<string> {
  const s = await stat(pagePath);
  const key = `${s.mtimeMs}:${s.size}`;
  if (templateCache?.key !== key) templateCache = { key, text: await readFile(pagePath, "utf8") };
  return templateCache.text;
}

const MAX_FORM_BODY = 16 * 1024;

/** Multipart overhead allowance on top of the file size limit. */
const MAX_UPLOAD_BODY = MAX_UPLOAD_BYTES + 64 * 1024;

/** Read a request body up to `limit` bytes (a BadRequestError beyond that). */
function readBody(request: IncomingMessage, limit: number, tooLarge: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BadRequestError(tooLarge));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** Read a small application/x-www-form-urlencoded body. */
async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams((await readBody(request, MAX_FORM_BODY, "Form body too large.")).toString("utf8"));
}

/**
 * Read a multipart/form-data body with Node's built-in parser (Response.formData()).
 * Returns the text fields as URLSearchParams and the uploaded file, if any.
 */
async function readMultipart(request: IncomingMessage): Promise<{ fields: URLSearchParams; file?: { name: string; bytes: Buffer } }> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.startsWith("multipart/form-data")) throw new BadRequestError("Upload: expected a multipart/form-data request.");
  const declared = Number(request.headers["content-length"] ?? 0);
  if (declared > MAX_UPLOAD_BODY) throw new BadRequestError(`Upload: file is too large; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  const body = await readBody(request, MAX_UPLOAD_BODY, `Upload: file is too large; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new BadRequestError("Upload: the form data could not be parsed.");
  }
  const fields = new URLSearchParams();
  let file: { name: string; bytes: Buffer } | undefined;
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields.set(key, value);
    else if (key === "file" && value.size > 0) file = { name: value.name, bytes: Buffer.from(await value.arrayBuffer()) };
  }
  return { fields, file };
}

/** Copy the page-state parameters a POST form carried along, for the redirect back. */
function passthroughOf(fields: URLSearchParams): URLSearchParams {
  const back = new URLSearchParams();
  for (const name of PASSTHROUGH_PARAMS) {
    const value = fields.get(name);
    if (value !== null && value !== "") back.set(name, value);
  }
  return back;
}

/** Create the HTTP server (not yet listening). */
export function createApp(): Server {
  return createServer(async (request, response) => {
    const headOnly = request.method === "HEAD";
    // B11: `new URL("//?x", base)` throws (protocol-relative with an empty host) - and it used to throw
    // outside the try below, taking the whole process down. Reject anything the parser rejects.
    let url: URL;
    try {
      const raw = request.url ?? "/";
      if (raw.startsWith("//")) throw new TypeError("protocol-relative path");
      url = new URL(raw, "http://localhost");
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS });
      response.end(headOnly ? undefined : "Bad request");
      return;
    }
    const pathname = url.pathname;

    // POST /upload: add an image (multipart) or remove an upload, then return to the page.
    if (request.method === "POST" && pathname === "/upload") {
      let back = new URLSearchParams();
      try {
        if ((request.headers["content-type"] ?? "").startsWith("multipart/form-data")) {
          const { fields, file } = await readMultipart(request);
          back = passthroughOf(fields);
          if (fields.get("action") === "remove") {
            const id = fields.get("id") ?? "";
            await removeUpload(id);
            if (back.get("image") === id) back.delete("image");
          } else {
            if (!file) throw new BadRequestError("Upload: no file was selected.");
            const saved = await saveUpload(file.name, file.bytes);
            back.set("image", saved.id);
          }
        } else {
          const form = await readForm(request);
          back = passthroughOf(form);
          if (form.get("action") !== "remove") throw new BadRequestError("Upload: expected a multipart/form-data request.");
          const id = form.get("id") ?? "";
          await removeUpload(id);
          if (back.get("image") === id) back.delete("image");
        }
        response.writeHead(303, { Location: pageUrl(back, {}), "Cache-Control": "no-store", ...BASE_HEADERS });
        response.end();
      } catch (error) {
        if (error instanceof BadRequestError) {
          const nonce = newNonce();
          const html = await renderViewerPage(await pageTemplate(), back, { watermarkError: error.message, nonce });
          response.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...htmlHeaders(nonce) });
          response.end(html);
          return;
        }
        console.error("Unable to handle the upload:", error);
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Unable to handle the upload.");
      }
      return;
    }

    // POST /watermark: set a custom text watermark or restore the stock one, then return to the page.
    if (request.method === "POST" && pathname === "/watermark") {
      try {
        const form = await readForm(request);
        const back = passthroughOf(form);
        if (form.get("action") === "restore") {
          await restoreStockWatermark();
        } else {
          const text = form.get("text") ?? "";
          try {
            await setCustomWatermarkText(text);
          } catch (error) {
            if (!(error instanceof BadRequestError)) throw error;
            // Re-render the page with the error and the typed text kept, so the user can fix it.
            const nonce = newNonce();
            const html = await renderViewerPage(await pageTemplate(), back, {
              watermarkError: error.message,
              watermarkTextInput: text,
              nonce,
            });
            response.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...htmlHeaders(nonce) });
            response.end(html);
            return;
          }
        }
        response.writeHead(303, { Location: pageUrl(back, {}), "Cache-Control": "no-store", ...BASE_HEADERS });
        response.end();
      } catch (error) {
        if (error instanceof BadRequestError) {
          response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", ...BASE_HEADERS });
          response.end(error.message);
          return;
        }
        console.error("Unable to update the watermark:", error);
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Unable to update the watermark.");
      }
      return;
    }

    if ((request.method !== "GET" && !headOnly) || pathname === "/watermark" || pathname === "/upload") {
      response.writeHead(405, { Allow: pathname === "/watermark" || pathname === "/upload" ? "POST" : "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }

    try {
      let body: Buffer;
      let contentType: string;
      let extraHeaders: Record<string, string> = BASE_HEADERS;

      if (pathname === "/" || pathname === "/index.html") {
        const nonce = newNonce();
        body = Buffer.from(await renderViewerPage(await pageTemplate(), url.searchParams, { nonce }), "utf8");
        contentType = "text/html; charset=utf-8";
        extraHeaders = htmlHeaders(nonce);
      } else if (pathname === "/image") {
        const options = parseImageOptions(url.searchParams);
        body = await withRenderSlot(() => renderImage(options));
        contentType = "image/png";
      } else if (pathname === "/android.zip") {
        const androidOptions = parseAndroidOptions(url.searchParams);
        const result = await withRenderSlot(() => renderAndroidZip(androidOptions));
        response.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Length": result.bytes.length,
          "Content-Disposition": `attachment; filename="${result.filename}"`,
          "Cache-Control": "no-store",
          ...BASE_HEADERS,
          "X-Android-Entries": String(result.entries.length),
          ...(result.warnings.length ? { "X-Android-Warnings": String(result.warnings.length) } : {}),
        });
        response.end(headOnly ? undefined : result.bytes);
        return;
      } else if (pathname === "/android/icon-preview") {
        // The adaptive icon as a launcher shows it (xxxhdpi visible area = 288 px, rendered at 432 for clarity).
        const options = parseAndroidOptions(url.searchParams);
        body = await withRenderSlot(() => renderIconComposite({ ...options, mode: "icon" }, 432, false));
        contentType = "image/png";
      } else if (pathname === "/export") {
        const exportOptions = parseExportOptions(url.searchParams);
        const result = await withRenderSlot(() => renderExport(exportOptions));
        const headers: Record<string, string | number> = {
          "Content-Type": result.contentType,
          "Content-Length": result.bytes.length,
          "Content-Disposition": `attachment; filename="${result.filename}"`,
          "Cache-Control": "no-store",
          ...BASE_HEADERS,
        };
        if (result.quality !== undefined) headers["X-Export-Quality"] = result.quality;
        if (result.warning) headers["X-Export-Warning"] = result.warning;
        response.writeHead(200, headers);
        response.end(headOnly ? undefined : result.bytes);
        return;
      } else if (pathname === DOCS.spec.page || pathname === DOCS.guide.page) {
        const doc = pathname === DOCS.spec.page ? DOCS.spec : DOCS.guide;
        body = Buffer.from(renderDocPage(await readFile(doc.path, "utf8"), doc), "utf8");
        contentType = "text/html; charset=utf-8";
        extraHeaders = htmlHeaders(newNonce());
      } else if (pathname === DOCS.spec.raw || pathname === DOCS.guide.raw) {
        body = await readFile(pathname === DOCS.spec.raw ? DOCS.spec.path : DOCS.guide.path);
        contentType = "text/markdown; charset=utf-8";
      } else {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(headOnly ? undefined : "Not found");
        return;
      }

      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        ...extraHeaders,
      });
      response.end(headOnly ? undefined : body);
    } catch (error) {
      if (error instanceof BadRequestError) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(headOnly ? undefined : error.message);
        return;
      }
      if (error instanceof ServiceUnavailableError) {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "1", "Cache-Control": "no-store" });
        response.end(headOnly ? undefined : error.message);
        return;
      }

      console.error("Unable to load the page or image:", error);
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(headOnly ? undefined : "Unable to load the page or image.");
    }
  });
}
