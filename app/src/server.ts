import { createApp } from "./app.ts";
import { hostWarning } from "./host.ts";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const server = createApp();

server.on("error", (error) => {
  console.error("Unable to start the server:", error.message);
  process.exitCode = 1;
});

const warning = hostWarning(host);
if (warning) console.warn(warning);

server.listen(port, host, () => {
  console.log(`Sharp Viewer: http://${host.includes(":") ? `[${host}]` : host}:${port}`);
});
