// Credentials belong to the local operator, never to the distributed source tree.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ownerCredentials } from "./credentials.mjs";

const { filename, credentials } = await ownerCredentials();
console.error(`[Vignet] Private owner credentials: ${filename}`);
console.error(
  "[Vignet] Use apiToken as MCP Bearer credential, deviceToken in extension connection settings.",
);
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("../bridge/http.mjs", import.meta.url))],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      ...process.env,
      VIGNETTE_API_TOKEN:
        process.env.VIGNETTE_API_TOKEN || credentials.apiToken,
      VIGNETTE_DEVICE_TOKEN:
        process.env.VIGNETTE_DEVICE_TOKEN || credentials.deviceToken,
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    windowsHide: true,
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.send({ type: "shutdown" }));
process.on("message", (message) => {
  if (message?.type === "shutdown") child.send(message);
});
child.once("exit", (code) => {
  process.exitCode = code || 0;
  process.disconnect?.();
});
