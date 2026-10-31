/** Shared helpers for the golden fixtures: start an isolated app, fetch, hash. */
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { readZip } from "../src/zip.ts";

export const fixturesDir = fileURLToPath(new URL("./fixtures/golden/", import.meta.url));

/** Stable file name for a URL: `page-03.html`, `bin-12.json`, `zip-01.json`. */
export const fixtureName = (kind: "page" | "bin" | "zip", index: number, ext: string) => `${kind}-${String(index).padStart(2, "0")}.${ext}`;

/** Image entries inside a ZIP that are compared pixel-tolerantly (README.txt is compared as text). */
export const isImageEntry = (name: string) => /\.(png|webp|jpe?g)$/i.test(name);

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export interface BinaryRecord {
  url: string;
  status: number;
  contentType: string;
  size: number;
  sha256: string;
  /** Headers that are part of the contract (export quality, filename). */
  headers: Record<string, string>;
}

export interface ZipRecord {
  url: string;
  status: number;
  filename: string;
  warnings: string;
  entries: Array<{ name: string; size: number; sha256: string | null }>;
  readme: string[];
}

const CONTRACT_HEADERS = ["content-disposition", "x-export-quality", "x-export-warning", "x-android-entries", "x-android-warnings"];

export async function fetchBinary(baseUrl: string, url: string): Promise<BinaryRecord & { bytes: Buffer }> {
  const response = await fetch(baseUrl + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const name of CONTRACT_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { url, status: response.status, contentType: response.headers.get("content-type") ?? "", size: bytes.length, sha256: sha256(bytes), headers, bytes };
}

export async function fetchZip(baseUrl: string, url: string): Promise<ZipRecord & { bytes: Buffer }> {
  const response = await fetch(baseUrl + url);
  const bytes = Buffer.from(await response.arrayBuffer());
  const entries = readZip(bytes).map((e) => ({
    name: e.name,
    size: e.data.length,
    sha256: e.name === "README.txt" ? null : sha256(e.data),
  }));
  const readme =
    readZip(bytes)
      .find((e) => e.name === "README.txt")
      ?.data.toString("utf8")
      .split("\n")
      .filter((l) => !l.startsWith("Generated ")) ?? [];
  return {
    url,
    status: response.status,
    filename: /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "",
    warnings: response.headers.get("x-android-warnings") ?? "",
    entries,
    readme,
    bytes,
  };
}

/** Page HTML with the only non-deterministic bit - the per-response CSP nonce - normalised. */
export async function fetchPage(baseUrl: string, url: string): Promise<{ status: number; html: string }> {
  const response = await fetch(baseUrl + url);
  const html = (await response.text()).replace(/nonce="[A-Za-z0-9_-]+"/g, 'nonce="<nonce>"');
  return { status: response.status, html };
}
