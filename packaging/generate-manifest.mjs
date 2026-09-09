#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`manifest: ${message}\n`);
  process.exitCode = 1;
}

const [version, format, artifactArgument, outputArgument, publishedNameArgument] = process.argv.slice(2);
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
  fail("first argument must be a semantic version");
} else if (format !== "sea" && format !== "portable") {
  fail("second argument must be sea or portable");
} else if (!artifactArgument || !outputArgument) {
  fail("usage: generate-manifest.mjs <version> <sea|portable> <artifact> <output> [published-filename]");
} else {
  const artifactPath = resolve(artifactArgument);
  // Builders hash a private staging file before they publish anything. The
  // optional name lets that staged content be described by its final public
  // filename without first making the artifact visible.
  const artifactName = publishedNameArgument ?? basename(artifactPath);
  if (!/^agentfleet-linux-x64-[A-Za-z0-9.+-]+(?:\.tar\.gz)?$/u.test(artifactName)) {
    fail("artifact filename is not an AgentFleet linux-x64 release name");
  } else {
    const contents = await readFile(artifactPath);
    const metadata = await stat(artifactPath);
    const manifest = {
      schemaVersion: 1,
      version,
      artifacts: {
        "linux-x64": {
          file: artifactName,
          sha256: createHash("sha256").update(contents).digest("hex"),
          size: metadata.size,
          format,
        },
      },
    };
    // A compact single line also lets the dependency-free POSIX installer
    // extract the tightly validated fields without requiring jq or Node.
    await writeFile(resolve(outputArgument), `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
  }
}
