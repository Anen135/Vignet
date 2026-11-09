// MCP over stdio (HTTP adapter or Inspector); local WebSocket for the extension.
// IMPORTANT: stdout belongs to MCP JSON-RPC. Log only to stderr.
import { createServer } from "node:http";
import { ExtensionRouter } from "./routing.mjs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { WebSocketServer } from "ws";
import * as z from "zod/v4";

const HOST = "127.0.0.1";
const PORT = Number(process.env.VIGNETTE_PORT || 8788);
const EXPECTED_EXTENSION_ID = process.env.VIGNETTE_EXTENSION_ID || "";
const router = new ExtensionRouter({
  token: process.env.VIGNETTE_DEVICE_TOKEN || "",
});
let lastSettings = null;

const httpServer = createServer((_, res) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

httpServer.on("upgrade", (request, socket, head) => {
  const origin = request.headers.origin || "";
  const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  const expectedOrigin =
    !EXPECTED_EXTENSION_ID ||
    origin === `chrome-extension://${EXPECTED_EXTENSION_ID}`;
  if (request.url !== "/extension" || !extensionOrigin || !expectedOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) =>
    wss.emit("connection", ws, request),
  );
});

wss.on("connection", (ws) => router.attach(ws));

function createMcpServer() {
  const server = new McpServer({ name: "chatgpt-vignette", version: "0.1.0" });

  server.registerTool(
    "set_vignette",
    {
      title: "Настроить виньетку ChatGPT",
      description:
        "Включить, выключить или изменить затемнение краёв страницы chatgpt.com в браузере пользователя. Используй при явной просьбе пользователя поменять виньетку.",
      inputSchema: z.object({
        enabled: z.boolean().default(true).describe("Показывать ли виньетку"),
        color: z
          .string()
          .regex(/^#[a-fA-F0-9]{6}$/)
          .default("#000000")
          .describe("Цвет в формате #RRGGBB"),
        opacity: z
          .number()
          .min(0)
          .max(1)
          .default(0.7)
          .describe("Сила затемнения краёв от 0 до 1"),
        innerRadius: z
          .number()
          .min(0)
          .max(90)
          .default(45)
          .describe("Процент центральной области без затемнения, от 0 до 90"),
      }),
    },
    async (settings) => {
      try {
        const result = await router.execute("set_vignette", settings);
        lastSettings = settings;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                tabsUpdated: result.tabsUpdated,
                settings,
              }),
            },
          ],
          structuredContent: {
            ok: true,
            tabsUpdated: result.tabsUpdated,
            settings,
          },
        };
      } catch (error) {
        return {
          isError: true,
          structuredContent: {
            ok: false,
            error: {
              code: error.code || "EXECUTION_FAILED",
              message: error.message,
            },
          },
          content: [
            {
              type: "text",
              text: `Не удалось применить виньетку: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "get_vignette_status",
    {
      title: "Статус расширения виньетки",
      description:
        "Проверить подключение браузерного расширения и узнать последние применённые настройки.",
      inputSchema: z.object({}),
    },
    async () => {
      const status = {
        extensionConnected: router.available().length > 0,
        lastSettings,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(status) }],
        structuredContent: status,
      };
    },
  );
  const target = z
    .object({
      deviceId: z.string().optional(),
      tabId: z.number().int().optional(),
    })
    .optional();
  const scope = z
    .enum(["current_chat", "global", "chat", "temporary"])
    .optional();
  const schemas = {
    list_assets: z.object({
      query: z.string().optional(),
      includeDisabled: z.boolean().optional(),
      target,
    }),
    describe_asset: z.object({ assetId: z.string(), target }),
    run_asset: z.object({
      assetId: z.string(),
      action: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).optional(),
      scope,
      target,
      instanceId: z.string().optional(),
    }),
    update_asset_instance: z.object({
      instanceId: z.string(),
      parameters: z.record(z.string(), z.unknown()),
      target,
    }),
    stop_asset: z.object({
      instanceId: z.string().optional(),
      assetId: z.string().optional(),
      scope,
      target,
    }),
    list_asset_instances: z.object({ scope, target }),
    get_contexts: z.object({}),
    get_asset_status: z.object({
      assetId: z.string().optional(),
      instanceId: z.string().optional(),
      target,
    }),
  };
  for (const [name, inputSchema] of Object.entries(schemas))
    server.registerTool(
      name,
      {
        description:
          name === "list_assets"
            ? "Discover installed effects, helpers and themes FIRST using this tool before run_asset. Returns current catalog, never source code."
            : `Vignet ${name}; select an explicit target from get_contexts when ambiguous.`,
        inputSchema,
      },
      async (args) => {
        try {
          const data = await router.execute(name, args);
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
          };
        } catch (error) {
          const data = {
            ok: false,
            error: {
              code: error.code || "EXECUTION_FAILED",
              message: error.message,
            },
          };
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
          };
        }
      },
    );
  return server;
}

httpServer.listen(PORT, HOST, () => {
  console.error(
    `[Bridge] WebSocket listening on ws://${HOST}:${PORT}/extension`,
  );
});
httpServer.on("error", (err) => {
  console.error(`[Bridge] Failed to listen: ${err.message}`);
  process.exitCode = 1;
  process.stdin.pause();
});

// The HTTP adapter or Inspector starts this process and uses stdin/stdout.
void serveStdio(createMcpServer);
