import { build } from "esbuild";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packExamples } from "./pack-asset.mjs";

export async function buildExtension(output = "dist/extension") {
  await mkdir(path.join(output, "ui"), { recursive: true });
  await build({
    entryPoints: ["extension/background.js"],
    outfile: path.join(output, "background.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome135",
    legalComments: "inline",
  });
  await build({
    entryPoints: ["extension/content.js"],
    outfile: path.join(output, "content.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome135",
    legalComments: "inline",
  });
  await build({
    entryPoints: ["extension/ui/app.js"],
    outfile: path.join(output, "ui/app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome135",
    legalComments: "inline",
  });
  for (const filename of ["index.html", "style.css"])
    await cp(
      path.join("extension/ui", filename),
      path.join(output, "ui", filename),
    );
  const manifest = JSON.parse(
    await readFile("extension/manifest.json", "utf8"),
  );
  manifest.background.type = "module";
  manifest.options_ui = { page: "ui/index.html", open_in_tab: true };
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return output;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  console.log(`Extension: ${await buildExtension()}`);
  console.log("Asset packages:", await packExamples());
}
