import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { tmpdir } from "node:os";

async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

async function waitForReady(child, logs) {
  const marker = "HTTPS туннель → HTTP Bridge: PASS";
  if (logs().includes(marker)) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`Launcher startup timed out:\n${logs()}`)),
      15000,
    );
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off("data", check);
      child.stderr.off("data", check);
      child.off("exit", ended);
      if (error) reject(error);
      else resolve();
    }
    function check() {
      if (logs().includes(marker)) finish();
    }
    function ended() {
      finish(new Error(`Launcher exited before readiness:\n${logs()}`));
    }
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("exit", ended);
  });
}

test(
  "menu runner stops the owned launcher over IPC and releases Bridge ports",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "vignet-cloudflare-lifecycle-"),
    );
    const httpPort = await port();
    const wsPort = await port();
    await mkdir(path.join(directory, "Vignet"));
    await writeFile(
      path.join(directory, "Vignet", "cloudflare.json"),
      JSON.stringify({
        mode: "existing",
        publicUrl: "https://fixture.example/mcp",
      }),
    );
    // Keep the actual HTTP bridge/process tree, substituting only the external
    // HTTPS transport so this lifecycle regression test never needs the internet.
    const bootstrap =
      "data:text/javascript," +
      encodeURIComponent(
        `const original=globalThis.fetch;globalThis.fetch=(url,options)=>original(String(url).replace('https://fixture.example','http://127.0.0.1:${httpPort}'),options);`,
      );
    const wrapper = `import {run} from './scripts/cloudflare.mjs'; process.on('message',m=>{if(m?.type==='interrupt') process.emit('SIGINT')}); try { await run(process.execPath,['--import',${JSON.stringify(bootstrap)},'scripts/cloudflare.mjs'],process.env,{ipc:true}); } finally {process.disconnect();}`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", wrapper],
      {
        windowsHide: true,
        env: {
          ...process.env,
          LOCALAPPDATA: directory,
          XDG_CONFIG_HOME: directory,
          VIGNETTE_CONFIG: path.join(directory, "credentials.json"),
          VIGNETTE_HTTP_PORT: String(httpPort),
          VIGNETTE_PORT: String(wsPort),
          CONTROL_PLANE_API_KEY: "never-used-openai-key",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let logs = "";
    child.stdout.on("data", (b) => (logs += b));
    child.stderr.on("data", (b) => (logs += b));
    const exited = new Promise((resolve) => child.once("exit", resolve));
    try {
      await waitForReady(child, () => logs);
      const config = await readFile(
        path.join(directory, "Vignet", "cloudflare.json"),
        "utf8",
      );
      assert.ok(!config.includes("never-used-openai-key"));
      child.send({ type: "interrupt" });
      const code = await Promise.race([
        exited,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("IPC shutdown timed out")), 5000),
        ),
      ]);
      assert.equal(code, 0, logs);
      await assert.rejects(fetch(`http://127.0.0.1:${httpPort}/health`));
      const probe = net.createServer();
      await new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(wsPort, "127.0.0.1", resolve);
      });
      await new Promise((resolve) => probe.close(resolve));
    } finally {
      if (child.connected) child.send({ type: "interrupt" });
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

for (const scenario of ["logs", "api", "error", "mismatch"]) {
  const authError = scenario === "error";
  const mismatch = scenario === "mismatch";
  const fail = authError || mismatch;
  const api = scenario === "api";
  test(
    `managed ngrok ${mismatch ? "rejects a changed URL instead of overwriting the pinned domain" : authError ? "reports authentication failure and cleans Bridge" : `discovers URL through ${scenario}, saves settings and stops both processes`}`,
    { timeout: 30000 },
    async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "vignet-ngrok-lifecycle-"),
      );
      const httpPort = await port();
      const wsPort = await port();
      const apiPort = await port();
      const marker = path.join(directory, "ngrok-process.json");
      await mkdir(path.join(directory, "Vignet"));
      await writeFile(
        path.join(directory, "Vignet", "cloudflare.json"),
        JSON.stringify({
          mode: "quick",
          ngrok: process.execPath,
          ngrokDomain: "https://fixture.ngrok-free.app",
        }),
      );
      // Use a real long-lived child process in place of the ngrok binary. This
      // tests ownership/cleanup, fragmented JSON logs and credential isolation
      // without an ngrok account or external network traffic.
      const bootstrapCode = `
      const {basename}=await import('node:path');
      if (basename(process.argv[1] || '') === 'http') {
        const {writeFile} = await import('node:fs/promises');
        await writeFile(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid, args:process.argv.slice(1), ownerToken:!!process.env.VIGNETTE_API_TOKEN, deviceToken:!!process.env.VIGNETTE_DEVICE_TOKEN, ngrokToken:!!process.env.NGROK_AUTHTOKEN}));
        if (${authError}) { console.error('ERR_NGROK_4018'); process.exit(1); }
        if (${api}) {
          const {createServer}=await import('node:http');
          const agent=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({endpoints:[{url:'https://fixture.ngrok-free.app',upstream:{url:'http://127.0.0.1:${httpPort}'}}]}))});
          await new Promise(resolve=>agent.listen(${apiPort},'127.0.0.1',resolve));
          console.log('Agent ready without URL startup log');
        } else {
          const entry=JSON.stringify({msg:'started tunnel',addr:'http://127.0.0.1:${httpPort}',url:'https://${mismatch ? "changed" : "fixture"}.ngrok-free.app'});
          process.stdout.write(entry.slice(0,20));setTimeout(()=>process.stdout.write(entry.slice(20)+'\\n'),10);
        }
        setInterval(()=>{},1000);await new Promise(()=>{});
      }
      const original=globalThis.fetch;globalThis.fetch=(url,options)=>original(String(url).replace('https://fixture.ngrok-free.app','http://127.0.0.1:${httpPort}'),options);
    `;
      const bootstrap =
        "data:text/javascript," + encodeURIComponent(bootstrapCode);
      const child = spawn(
        process.execPath,
        ["scripts/cloudflare.mjs", "--ngrok"],
        {
          windowsHide: true,
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${bootstrap}`,
            LOCALAPPDATA: directory,
            XDG_CONFIG_HOME: directory,
            VIGNETTE_CONFIG: path.join(directory, "credentials.json"),
            VIGNETTE_HTTP_PORT: String(httpPort),
            VIGNETTE_NGROK_API_PORT: String(apiPort),
            VIGNETTE_PORT: String(wsPort),
            NGROK_AUTHTOKEN: "fixture-ngrok-secret",
            VIGNETTE_API_TOKEN: "parent-owner-secret",
            VIGNETTE_DEVICE_TOKEN: "parent-device-secret",
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let logs = "";
      child.stdout.on("data", (b) => (logs += b));
      child.stderr.on("data", (b) => (logs += b));
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        if (!fail) await waitForReady(child, () => logs);
        if (fail) {
          assert.equal(await exited, 1, logs);
          assert.match(
            logs,
            authError ? /ERR_NGROK_4018/ : /Подмена адреса запрещена/,
          );
          const unchanged = JSON.parse(
            await readFile(
              path.join(directory, "Vignet", "cloudflare.json"),
              "utf8",
            ),
          );
          assert.equal(unchanged.ngrokDomain, "https://fixture.ngrok-free.app");
          assert.equal(unchanged.publicUrl, undefined);
        } else {
          assert.match(
            logs,
            /MCP URL: https:\/\/fixture\.ngrok-free\.app\/mcp/,
          );
          assert.match(logs, /HTTPS туннель → HTTP Bridge: PASS/);
          const settings = JSON.parse(
            await readFile(
              path.join(directory, "Vignet", "cloudflare.json"),
              "utf8",
            ),
          );
          assert.equal(settings.mode, "ngrok");
          assert.equal(settings.ngrok, process.execPath);
          assert.equal(settings.ngrokDomain, "https://fixture.ngrok-free.app");
          assert.equal(
            settings.publicUrl,
            "https://fixture.ngrok-free.app/mcp",
          );
          assert.ok(!JSON.stringify(settings).includes("fixture-ngrok-secret"));
          child.send({ type: "shutdown" });
          assert.equal(await exited, 0, logs);
        }
        const agent = JSON.parse(await readFile(marker, "utf8"));
        assert.equal(agent.ownerToken, false);
        assert.equal(agent.deviceToken, false);
        assert.equal(agent.ngrokToken, true);
        assert.ok(agent.args.includes("--inspect=false"));
        assert.equal(
          agent.args[agent.args.indexOf("--url") + 1],
          "https://fixture.ngrok-free.app",
        );
        assert.throws(
          () => process.kill(agent.pid, 0),
          "owned ngrok process must exit",
        );
        assert.ok(!logs.includes("fixture-ngrok-secret"));
        await assert.rejects(fetch(`http://127.0.0.1:${httpPort}/health`));
      } finally {
        if (child.connected) child.send({ type: "shutdown" });
        await exited;
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
