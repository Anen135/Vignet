import { access, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { operatorDirectory, ownerCredentials } from "./credentials.mjs";
import {
  findCloudflared,
  findNgrok,
  ngrokCommand,
  normalizeNgrokDomain,
  preferredEndpoint,
  readSettings,
  root,
  run,
  saveSettings,
} from "./cloudflare.mjs";
import { publicOrigin } from "../bridge/oauth.mjs";

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "npm run setup — меню Vignet: расширение, Cloudflare и ngrok. Ключ OpenAI не нужен.",
    );
    return;
  }
  if (!process.stdin.isTTY)
    throw new Error("Открой обычный терминал и выполни npm run setup.");
  let settings = await readSettings();
  const ui = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  ui.on("SIGINT", () => ui.close());
  const ask = async (label) => (await ui.question(label)).trim();
  async function child(command, args, ipc = false) {
    ui.pause();
    process.stdin.setRawMode(false);
    try {
      await run(command, args, process.env, { ipc });
    } finally {
      if (!ui.closed) {
        process.stdin.setRawMode(true);
        ui.resume();
      }
    }
  }
  async function npm(args) {
    if (!process.env.npm_execpath)
      throw new Error("Запусти меню через npm run setup.");
    await child(process.execPath, [process.env.npm_execpath, ...args]);
  }
  async function build() {
    try {
      await access(path.join(root, "node_modules", "esbuild", "package.json"));
    } catch {
      await npm(["install"]);
    }
    await npm(["run", "build"]);
    await ownerCredentials();
    console.log(
      `\nРасширение собрано: ${path.join(root, "dist", "extension")}\nОткрой chrome://extensions (Opera: opera://extensions) → Режим разработчика → Загрузить распакованное расширение.\nДля дождя включи Allow User Scripts и импортируй dist/packages/rain.vignet.`,
    );
  }
  async function configure() {
    console.log(
      "\n1. Cloudflare Quick Tunnel — автоматический запуск; URL меняется при перезапуске.\n2. Уже работающий HTTPS туннель — укажи публичный URL.\n3. ngrok — автоматический запуск с закреплённым адресом аккаунта.\nУказанный старый trycloudflare.com адрес нельзя зарезервировать или создать заново.",
    );
    const defaultMode =
      settings.mode === "ngrok"
        ? "3"
        : settings.mode === "existing"
          ? "2"
          : "1";
    const mode = (await ask(`Режим [${defaultMode}]: `)) || defaultMode;
    if (!["1", "2", "3"].includes(mode)) throw new Error("Выбери 1, 2 или 3.");
    let next;
    if (mode === "1" || mode === "3") {
      const isNgrok = mode === "3";
      const agent = isNgrok ? "ngrok" : "cloudflared";
      const detected = isNgrok
        ? settings.ngrok || process.env.NGROK_PATH || (await findNgrok())
        : settings.cloudflared ||
          process.env.CLOUDFLARED_PATH ||
          (await findCloudflared());
      const entered = await ask(
        `${isNgrok ? "Команда или путь к ngrok (для Microsoft Store достаточно ngrok)" : "Путь к cloudflared"}${detected ? ` [${detected}]` : ".exe"}: `,
      );
      if (!entered && !detected)
        throw new Error(
          isNgrok
            ? "Скачай ngrok: https://ngrok.com/download"
            : "Скачай cloudflared: https://developers.cloudflare.com/tunnel/downloads/",
        );
      const binary = isNgrok
        ? ngrokCommand(entered || detected)
        : path.resolve((entered || detected).replace(/^"|"$/g, ""));
      if (!isNgrok && !(await stat(binary)).isFile())
        throw new Error(`Укажи исполняемый файл ${agent}, а не папку или ZIP.`);
      try {
        await child(binary, [isNgrok ? "version" : "--version"]);
      } catch (error) {
        if (isNgrok && error.code === "ENOENT")
          throw new Error(
            "Команда ngrok не найдена. После установки Microsoft Store открой терминал заново или укажи путь к ngrok.exe.",
          );
        throw error;
      }
      next = {
        ...settings,
        mode: isNgrok ? "ngrok" : "quick",
        [isNgrok ? "ngrok" : "cloudflared"]: binary,
        publicUrl: "",
      };
      if (isNgrok) {
        const previous = settings.ngrokDomain || "";
        console.log(
          "Открой https://dashboard.ngrok.com/domains и скопируй закреплённый dev domain. URL из лога прошлого запуска для этого не подходит.",
        );
        next.ngrokDomain = normalizeNgrokDomain(
          (await ask(
            `Постоянный домен ngrok${previous ? ` [${previous}]` : ""}: `,
          )) || previous,
        );
        next.publicUrl = `${next.ngrokDomain}/mcp`;
        console.log(
          "Будет использован authtoken из стандартной конфигурации ngrok или NGROK_AUTHTOKEN. Если он ещё не настроен: https://dashboard.ngrok.com/get-started/your-authtoken. В настройки Vignet токен не записывается.",
        );
      }
    } else {
      const fallback =
        (settings.mode === "existing" && settings.publicUrl) ||
        preferredEndpoint;
      const entered =
        (await ask(`Публичный MCP URL [${fallback}]: `)) || fallback;
      next = {
        ...settings,
        mode: "existing",
        publicUrl: `${publicOrigin(entered)}/mcp`,
      };
      console.log(
        `Существующий туннель должен направлять запросы на http://127.0.0.1:${process.env.VIGNETTE_HTTP_PORT || 8789}. Его процесс меню не запускает и не останавливает.`,
      );
    }
    await ownerCredentials();
    await saveSettings(next);
    settings = next;
    console.log("Настройки сохранены. Выбери пункт 2 для запуска.");
  }
  function instructions() {
    console.log(
      `\nВ расширении:\n  Endpoint: ws://127.0.0.1:${process.env.VIGNETTE_PORT || 8788}/extension\n  deviceToken: из файла ${process.env.VIGNETTE_CONFIG || path.join(operatorDirectory, "credentials.json")}\n\nВ ChatGPT: Plugins → + → Add custom MCP server\n  Connection: Server URL\n  URL: ${settings.publicUrl || "будет показан после запуска туннеля"}\n  Authentication: OAuth (поля Client ID / Secret оставь пустыми для автоматической регистрации)\nПри подключении сверь код в браузере и терминале, затем введи «да» в терминале Vignet.\nКлючи и туннели OpenAI не нужны. Старые настройки OpenAI больше не используются.\nQuick Tunnel выдаёт новый случайный URL после каждого перезапуска.`,
    );
  }
  async function diagnostics() {
    const base = `http://127.0.0.1:${process.env.VIGNETTE_HTTP_PORT || 8789}`;
    const local = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const identity = await local.json();
    if (!local.ok || !identity.ok) throw new Error("Bridge ещё не готов.");
    console.log("Локальный HTTP Bridge: PASS");
    if (!settings.publicUrl)
      throw new Error("Нет публичного адреса. Сначала запусти пункт 2.");
    const origin = publicOrigin(settings.publicUrl);
    const remote = await fetch(`${origin}/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const remoteIdentity = await remote.json();
    if (
      !remote.ok ||
      !identity.instanceId ||
      remoteIdentity.instanceId !== identity.instanceId
    )
      throw new Error("Публичный URL ведёт в другой или остановленный Bridge.");
    const response = await fetch(settings.publicUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (
      response.status !== 401 ||
      !response.headers.get("www-authenticate")?.includes("resource_metadata")
    )
      throw new Error("Публичный MCP должен требовать OAuth (401).");
    console.log(
      "HTTPS туннель → этот Bridge: PASS\nПубличный MCP защищён OAuth: PASS",
    );
  }
  try {
    console.log("\nVignet — Cloudflare / ngrok");
    while (!ui.closed) {
      console.log(
        "\n1. Настроить всё (расширение + Cloudflare)\n2. Запустить Bridge и туннель\n3. Проверить работающее подключение\n4. Собрать / обновить расширение\n5. Настроить туннель\n6. Как подключить ChatGPT и расширение\n0. Выход",
      );
      let choice;
      try {
        choice = await ask("Выбор: ");
      } catch {
        break;
      }
      try {
        if (choice === "0") break;
        if (choice === "1") {
          await build();
          await configure();
          instructions();
        } else if (choice === "2") {
          await child(
            process.execPath,
            [path.join(root, "scripts", "cloudflare.mjs")],
            true,
          );
          settings = await readSettings();
        } else if (choice === "3") {
          settings = await readSettings();
          await diagnostics();
        } else if (choice === "4") await build();
        else if (choice === "5") await configure();
        else if (choice === "6") {
          settings = await readSettings();
          instructions();
        } else console.log("Введи номер пункта меню.");
      } catch (error) {
        if (ui.closed) break;
        console.error(`\nОшибка: ${error.message}`);
      }
    }
  } finally {
    ui.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  });
}
