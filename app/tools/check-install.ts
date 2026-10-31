/**
 * Pre-flight for `npm test` / `npm run dev`: fail fast with ONE clear line when the dependencies
 * are missing or sharp's native binary does not match this platform, instead of 16 stack traces.
 * Uses only Node built-ins so it can never be the missing piece itself.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

function fail(lines: string[]): never {
  console.error(["", "Sharp Viewer: cannot run yet.", ...lines.map((l) => `  ${l}`), ""].join("\n"));
  process.exit(1);
}

if (!existsSync(`${root}node_modules/sharp/package.json`)) {
  fail(['Dependencies are not installed: run "npm ci" in the project folder first, then try again.', `(looked for ${root}node_modules/sharp)`]);
}

// Installed version must be the pinned one: the lockfile is the contract (a drifted install means
// `npm install <pkg>`, `npm update`, or a tool that ignores package-lock.json was used).
const wanted = String((require(`${root}package.json`) as { dependencies: Record<string, string> }).dependencies.sharp);
const installed = String((require(`${root}node_modules/sharp/package.json`) as { version: string }).version);
if (installed !== wanted) {
  fail([
    `sharp ${installed} is installed but the project pins ${wanted} (package.json / package-lock.json).`,
    "The code is written against the pinned version (types and pixel output are verified for it).",
    "Restore the pinned tree: git checkout package.json package-lock.json && rm -rf node_modules && npm ci",
    "(To upgrade sharp on purpose, change the pin, run npm install, and regenerate the goldens: node tests/golden.update.ts)",
  ]);
}

try {
  require("sharp");
} catch (error) {
  const message = (error as Error).message.split("\n")[0] ?? String(error);
  fail([
    `sharp is installed but cannot load on this machine (${process.platform}-${process.arch}, Node ${process.versions.node}):`,
    message,
    'Usually a node_modules copied from another OS/CPU: delete node_modules and run "npm ci" here.',
  ]);
}
