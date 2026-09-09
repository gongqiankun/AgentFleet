import { RuntimePromotion } from "./runtime-promotion.js";
import { channelState } from "./runtime-channel.js";
const directory = process.env.RUNTIME_RELEASE_DIR;
if (!directory) throw new Error("RUNTIME_RELEASE_DIR is required");
const promotion = new RuntimePromotion(directory, process.env.RUNTIME_BASELINE_DIR ?? "/app/web/downloads");
let stopping = false;
process.on("SIGTERM", () => { stopping = true; }); process.on("SIGINT", () => { stopping = true; });
// A named singleton container is the sole writer of state/targets. The panel only writes control.json.
const heartbeat = setInterval(() => promotion.heartbeat(), 15_000);
try {
  promotion.heartbeat();
  await promotion.bootstrap();
  while (!stopping) {
    await promotion.run();
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
} catch (error) {
  promotion.save({ ...channelState(directory), phase: "failed", message: error instanceof Error ? error.message.slice(0, 1200) : "验证服务启动失败" });
  process.exitCode = 1;
} finally { clearInterval(heartbeat); }
