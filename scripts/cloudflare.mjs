import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { operatorDirectory, ownerCredentials } from "./credentials.mjs";
import { publicOrigin } from "../bridge/oauth.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const settingsFile = path.join(operatorDirectory, "cloudflare.json");
export const preferredEndpoint =
  "https://prevention-highways-algorithm-ing.trycloudflare.com/mcp";

export async function findCloudflared(directory = root) {
  return findBinary("cloudflared", /^(tunnel-client|cloudflared)/, directory);
}

export async function findNgrok(directory = root) {
  // Microsoft Store execution aliases may reject stat/access but still launch.
  // Let Windows resolve the command instead of inspecting its protected stub.
  return (await findBinary("ngrok", /^ngrok/, directory)) || "ngrok";
}

export function ngrokCommand(value = "ngrok") {
  const command = value.trim().replace(/^"(.*)"$/, "$1") || "ngrok";
  return /^ngrok(?:\.exe)?$/i.test(command) ? command : path.resolve(command);
}

async function findBinary(name, prefix, directory) {
  const filename = process.platform === "win32" ? `${name}.exe` : name;
  const entries = await readdir(directory, { withFileTypes: true });
  const folders = [
    directory,
    ...entries
      .filter((entry) => entry.isDirectory() && prefix.test(entry.name))
      .map((entry) => path.join(directory, entry.name)),
    ...(process.env.PATH || "").split(path.delimiter),
  ];
  for (const folder of folders) {
    const candidate = path.join(folder, filename);
    try {
      if ((await stat(candidate)).isFile()) return path.resolve(candidate);
    } catch {}
  }
  return "";
}

export async function readSettings() {
  try {
    return JSON.parse(await readFile(settingsFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

export async function saveSettings(settings) {
  if (!["quick", "existing", "ngrok"].includes(settings.mode))
    throw new Error("Неизвестный режим туннеля.");
  if (settings.mode === "existing") publicOrigin(settings.publicUrl);
  if (settings.mode === "ngrok") normalizeNgrokDomain(settings.ngrokDomain);
  await mkdir(operatorDirectory, { recursive: true });
  // Explicit fields only: no OpenAI credentials or old tunnel configuration.
  const saved = {
    mode: settings.mode,
    cloudflared: settings.cloudflared || "",
    ngrok: settings.ngrok || "",
    ngrokDomain: settings.ngrokDomain
      ? normalizeNgrokDomain(settings.ngrokDomain)
      : "",
    publicUrl: settings.publicUrl || "",
  };
  await writeFile(settingsFile, JSON.stringify(saved, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function quickTunnelArgs(port, config) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Неверный HTTP порт.");
  return [
    "tunnel",
    "--config",
    config,
    "--no-autoupdate",
    "--protocol",
    "http2",
    "--url",
    `http://127.0.0.1:${port}`,
  ];
}

export function quickTunnelUrl(line) {
  return (
    line.match(
      /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/,
    )?.[0] || ""
  );
}

export function normalizeNgrokDomain(value) {
  const domain = typeof value === "string" ? value.trim() : "";
  if (!domain)
    throw new Error(
      "Постоянный домен ngrok не настроен. Открой npm run setup → 5 → 3 и укажи dev domain из https://dashboard.ngrok.com/domains. Случайный адрес использоваться не будет.",
    );
  return publicOrigin(domain.includes("://") ? domain : `https://${domain}`);
}

export function ngrokArgs(port, domain) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Неверный HTTP порт.");
  return [
    "http",
    `http://127.0.0.1:${port}`,
    "--url",
    normalizeNgrokDomain(domain),
    "--log=stdout",
    "--log-format=json",
    "--log-level=info",
    "--inspect=false",
  ];
}

export function ngrokTunnelUrl(line, port) {
  try {
    const entry = JSON.parse(line);
    if (
      !["started tunnel", "started endpoint"].includes(entry.msg) ||
      typeof entry.url !== "string"
    )
      return "";
    if (entry.addr && entry.addr !== `http://127.0.0.1:${port}`) return "";
    return publicOrigin(entry.url);
  } catch {
    return "";
  }
}

export async function discoverNgrokUrl(
  port,
  apiPort = 4040,
  expectedOrigin = "",
) {
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535)
    throw new Error("Неверный порт локального API ngrok.");
  try {
    const base = `http://127.0.0.1:${apiPort}/api`;
    let response = await fetch(`${base}/endpoints`, {
      redirect: "error",
      signal: AbortSignal.timeout(800),
    });
    let legacy = false;
    if (response.status === 404) {
      legacy = true;
      response = await fetch(`${base}/tunnels`, {
        redirect: "error",
        signal: AbortSignal.timeout(800),
      });
    }
    if (!response.ok) return "";
    const data = await response.json();
    const endpoints = legacy ? data.tunnels : data.endpoints;
    if (!Array.isArray(endpoints)) return "";
    for (const entry of endpoints) {
      const raw = legacy ? entry.config?.addr : entry.upstream?.url;
      if (typeof raw !== "string") continue;
      try {
        const upstream = new URL(raw.includes("://") ? raw : `http://${raw}`);
        if (
          upstream.protocol !== "http:" ||
          !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) ||
          Number(upstream.port || 80) !== port ||
          upstream.pathname !== "/" ||
          upstream.search ||
          upstream.username ||
          upstream.password
        )
          continue;
        const origin = publicOrigin(legacy ? entry.public_url : entry.url);
        if (!expectedOrigin || origin === expectedOrigin) return origin;
      } catch {
        /* Ignore unrelated/malformed endpoints. */
      }
    }
  } catch {
    /* The local agent may still be starting. */
  }
  return "";
}

export async function ensurePortFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error(
          `Порт ${port} занят. Останови прежний Bridge или туннель через Ctrl+C.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export function run(command, args, env = process.env, { ipc = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
      windowsHide: true,
    });
    const stop = () => {
      if (ipc && child.connected) child.send({ type: "shutdown" }, () => {});
      else child.kill("SIGINT");
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Команда завершилась (${signal || code}). Проверь сообщение выше.`,
          ),
        );
    });
  });
}

export async function startCloudflare(settings) {
  settings ||= await readSettings();
  const httpPort = Number(process.env.VIGNETTE_HTTP_PORT || 8789);
  const wsPort = Number(process.env.VIGNETTE_PORT || 8788);
  await ensurePortFree(httpPort);
  await ensurePortFree(wsPort);
  const mode = settings.mode || "quick";
  if (!["quick", "existing", "ngrok"].includes(mode))
    throw new Error("Выбери режим туннеля в npm run setup.");
  const pinnedOrigin =
    mode === "ngrok"
      ? normalizeNgrokDomain(
          settings.ngrokDomain || process.env.VIGNETTE_NGROK_DOMAIN,
        )
      : "";
  let publicUrl = mode === "existing" ? publicOrigin(settings.publicUrl) : "";
  const binary =
    mode === "quick"
      ? settings.cloudflared ||
        process.env.CLOUDFLARED_PATH ||
        (await findCloudflared())
      : mode === "ngrok"
        ? ngrokCommand(
            settings.ngrok || process.env.NGROK_PATH || (await findNgrok()),
          )
        : "";
  const provider = mode === "ngrok" ? "ngrok" : "cloudflared";
  if (mode !== "existing" && !binary)
    throw new Error(
      `Не найден ${provider}. Укажи путь через npm run setup → 5.`,
    );
  if (binary && mode === "quick") await access(binary);
  const { credentials } = await ownerCredentials();
  await mkdir(operatorDirectory, { recursive: true });
  const instanceId = randomBytes(16).toString("hex");
  const env = {
    ...process.env,
    VIGNETTE_OAUTH: "1",
    VIGNETTE_PUBLIC_URL: publicUrl,
    VIGNETTE_INSTANCE_ID: instanceId,
    VIGNETTE_OAUTH_CLIENTS: path.join(operatorDirectory, "oauth-clients.json"),
    VIGNETTE_API_TOKEN: credentials.apiToken,
    VIGNETTE_DEVICE_TOKEN:
      process.env.VIGNETTE_DEVICE_TOKEN || credentials.deviceToken,
  };
  delete env.CONTROL_PLANE_API_KEY;
  delete env.NGROK_AUTHTOKEN;
  const children = [];
  const readers = [];
  let stopping = false;
  let failure;
  let complete;
  const done = new Promise((resolve) => {
    complete = resolve;
  });
  const prompt = process.stdin.isTTY
    ? createPrompt({ input: process.stdin, output: process.stdout })
    : null;
  let approvalQueue = Promise.resolve();
  async function stop(error) {
    if (stopping) return;
    stopping = true;
    failure = error;
    prompt?.close();
    for (const child of children) {
      if (child.connected) child.send({ type: "shutdown" }, () => {});
      else if (child.exitCode === null) child.kill();
    }
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }),
    );
    complete();
  }
  function managed(command, args, ipc = false, childEnv = env) {
    const child = spawn(command, args, {
      cwd: root,
      env: childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])],
    });
    children.push(child);
    child.once("error", (error) => void stop(error));
    child.once("exit", (code, signal) => {
      if (!stopping)
        void stop(
          new Error(
            `${ipc ? "HTTP Bridge" : provider} остановился (${signal || code}).${!ipc && mode === "ngrok" ? " Проверь ngrok config check и authtoken аккаунта ngrok." : ""}`,
          ),
        );
    });
    return child;
  }
  async function health(base) {
    try {
      const response = await fetch(`${base}/health`, {
        redirect: "error",
        signal: AbortSignal.timeout(2000),
      });
      const result = await response.json();
      return response.ok && result.ok && result.instanceId === instanceId;
    } catch {
      return false;
    }
  }
  const signalStop = () => void stop();
  process.on("SIGINT", signalStop);
  process.on("SIGTERM", signalStop);
  const parentMessage = (message) => {
    if (message?.type === "shutdown") void stop();
  };
  process.on("message", parentMessage);
  if (process.connected) process.once("disconnect", signalStop);
  prompt?.on("SIGINT", signalStop);
  try {
    const bridge = managed(
      process.execPath,
      [path.join(root, "bridge", "http.mjs")],
      true,
    );
    bridge.stdout.on("data", (chunk) => process.stdout.write(chunk));
    bridge.stderr.on("data", (chunk) => process.stderr.write(chunk));
    bridge.on("message", (message) => {
      if (message?.type !== "oauth-approval") return;
      approvalQueue = approvalQueue
        .then(async () => {
          if (stopping || !bridge.connected || message.expiresAt <= Date.now())
            return;
          let approved = false;
          try {
            const redirect = new URL(message.redirect);
            console.log(
              `\nЗапрос доступа к Vignet. Код: ${message.verificationCode}\nСверь код с открытой страницей подключения. Возврат: ${redirect.origin}${redirect.pathname}`,
            );
            if (prompt)
              approved = /^(y|yes|д|да)$/i.test(
                (
                  await prompt.question("Разрешить? [да/НЕТ]: ", {
                    signal: AbortSignal.timeout(
                      Math.max(
                        1,
                        Math.min(40000, message.expiresAt - Date.now()),
                      ),
                    ),
                  })
                ).trim(),
              );
            else
              console.log(
                "Для подтверждения OAuth запусти npm run start:cloudflare в интерактивном терминале.",
              );
          } catch {}
          if (bridge.connected)
            bridge.send(
              {
                type: "oauth-decision",
                requestId: message.requestId,
                approved,
              },
              () => {},
            );
        })
        .catch(() => {});
    });
    let ready = false;
    for (let n = 0; n < 60 && !stopping; n++) {
      if (await health(`http://127.0.0.1:${httpPort}`)) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw failure || new Error("HTTP Bridge не запустился.");
    if (mode !== "existing") {
      let args;
      if (mode === "quick") {
        const config = path.join(operatorDirectory, "cloudflare-quick.yml");
        await writeFile(config, "{}\n", { mode: 0o600 });
        args = quickTunnelArgs(httpPort, config);
      } else args = ngrokArgs(httpPort, pinnedOrigin);
      // Tunnel agents do not need the Bridge's owner/device credentials.
      const tunnelEnv = { ...process.env };
      for (const key of [
        "CONTROL_PLANE_API_KEY",
        "VIGNETTE_API_TOKEN",
        "VIGNETTE_DEVICE_TOKEN",
      ])
        delete tunnelEnv[key];
      const tunnel = managed(binary, args, false, tunnelEnv);
      console.log(`Запускаю ${provider}. Ожидаю публичный HTTPS адрес…`);
      const acceptUrl = (found) => {
        if (found && mode === "ngrok" && found !== pinnedOrigin) {
          void stop(
            new Error(
              `ngrok вернул другой адрес (${found}) вместо закреплённого ${pinnedOrigin}. Подмена адреса запрещена; проверь домен аккаунта ngrok.`,
            ),
          );
          return;
        }
        if (found && !publicUrl && !stopping) {
          publicUrl = found;
          bridge.send({ type: "public-url", url: found }, () => {});
        }
      };
      for (const stream of [tunnel.stdout, tunnel.stderr]) {
        const reader = createInterface({ input: stream });
        readers.push(reader);
        reader.on("line", (line) => {
          if (mode === "quick") console.error(line);
          else {
            const errorCode = line.match(/\bERR_NGROK_\d+\b/)?.[0];
            if (errorCode)
              console.error(
                `[ngrok] ${errorCode}. Проверь ngrok config check и authtoken: https://dashboard.ngrok.com/get-started/your-authtoken`,
              );
          }
          const found =
            mode === "ngrok"
              ? ngrokTunnelUrl(line, httpPort)
              : quickTunnelUrl(line);
          acceptUrl(found);
        });
      }
      const deadline = Date.now() + 60000;
      let nextProbe = 0;
      while (!publicUrl && !stopping && Date.now() < deadline) {
        if (mode === "ngrok" && Date.now() >= nextProbe) {
          acceptUrl(
            await discoverNgrokUrl(
              httpPort,
              Number(process.env.VIGNETTE_NGROK_API_PORT || 4040),
              pinnedOrigin,
            ),
          );
          nextProbe = Date.now() + 1000;
        }
        if (publicUrl || stopping) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!publicUrl)
        throw (
          failure ||
          new Error(
            `${provider} не выдал URL за 60 секунд. Проверь сеть, настройки агента и сообщения выше.`,
          )
        );
    }
    console.log(
      `\nMCP URL: ${publicUrl}/mcp\nВ ChatGPT выбери Server URL и OAuth. Когда появится запрос доступа, подтверди его здесь.\nКлюч OpenAI не требуется. Ctrl+C останавливает Bridge и запущенный этим окном туннель.`,
    );
    console.log("Проверяю, что публичный адрес ведёт в этот Bridge...");
    let routed = false;
    for (let n = 0; n < 30 && !stopping; n++) {
      if (await health(publicUrl)) {
        routed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!routed && !stopping)
      throw new Error(
        "Публичный URL не ведёт к этому Bridge. Для существующего туннеля направь origin на http://127.0.0.1:" +
          httpPort +
          ".",
      );
    if (routed) {
      await saveSettings({
        ...settings,
        mode,
        ...(mode === "ngrok" ? { ngrokDomain: pinnedOrigin } : {}),
        ...(mode === "quick"
          ? { cloudflared: binary }
          : mode === "ngrok"
            ? { ngrok: binary }
            : {}),
        publicUrl: `${publicUrl}/mcp`,
      });
      console.log(
        "HTTPS туннель → HTTP Bridge: PASS. Оставь терминал открытым.",
      );
    }
    await done;
    if (failure) throw failure;
  } finally {
    await stop();
    for (const reader of readers) reader.close();
    process.off("SIGINT", signalStop);
    process.off("SIGTERM", signalStop);
    process.off("message", parentMessage);
    process.off("disconnect", signalStop);
    prompt?.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const settings = await readSettings();
  if (process.argv.includes("--ngrok")) settings.mode = "ngrok";
  startCloudflare(settings).catch((error) => {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  });
}
