if (process.env.NODE_NO_WARNINGS !== "1") {
  const { spawnSync } = require("node:child_process");
  const child = spawnSync(process.execPath, process.argv.slice(2), {
    stdio: "inherit",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  process.exit(child.status === null ? 1 : child.status);
}
