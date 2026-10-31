/** Bind-address helpers for the entry point (A11): the tool is designed for loopback only. */

export function isLoopback(host: string): boolean {
  const h = host
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** A loud startup warning when the server is exposed beyond the local machine, else null. */
export function hostWarning(host: string): string | null {
  if (isLoopback(host)) return null;
  return [
    `WARNING: Sharp Viewer is listening on ${host}, which is reachable from other machines.`,
    "It has no authentication, no TLS and no rate limiting; the shared uploads and the custom watermark are visible to every client.",
    "It is a single-user local tool: put it behind an authenticating reverse proxy or bind to 127.0.0.1.",
  ].join("\n");
}
