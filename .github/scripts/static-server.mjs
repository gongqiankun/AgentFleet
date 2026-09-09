#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const [rootArgument, portFile] = process.argv.slice(2);
if (!rootArgument || !portFile) throw new Error("usage: static-server.mjs <root> <port-file>");
const root = await realpath(rootArgument);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const candidate = resolve(root, `.${decodeURIComponent(pathname)}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error("unsafe path");
    const canonical = await realpath(candidate);
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) throw new Error("unsafe target");
    if (!(await stat(canonical)).isFile()) throw new Error("not a file");
    response.statusCode = 200;
    response.setHeader("content-type", extname(canonical) === ".json" ? "application/json" : "application/octet-stream");
    createReadStream(canonical).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end("not found\n");
  }
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected server address");
  await writeFile(portFile, `${address.port}\n`, { mode: 0o600 });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
