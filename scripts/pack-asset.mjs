import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  packPackage,
  inspectPackage,
  sha256,
} from "../extension/core/installer.js";
import { validateManifest } from "../extension/core/model.js";

// Compile ES module lifecycle exports into a classic USER_SCRIPT-world bundle.
// Only declared resources enter the distributable. Runtime never imports source modules.
export async function packAsset(directory, destination) {
  const root = await realpath(directory);
  const manifest = validateManifest(
    JSON.parse(await readFile(path.join(root, "asset.json"), "utf8")),
  );
  const declared = [
    ...new Set(
      [
        manifest.entry,
        ...(manifest.scripts || []),
        ...(manifest.styles || []),
        ...(manifest.media || []),
      ].filter(Boolean),
    ),
  ];
  const files = [];
  for (const logicalPath of declared) {
    if (
      typeof logicalPath !== "string" ||
      logicalPath.includes("\\") ||
      logicalPath.startsWith("/") ||
      logicalPath
        .split("/")
        .some((part) => !part || part === "." || part === "..")
    )
      throw new Error(`Unsafe path: ${logicalPath}`);
    const absolute = await realpath(path.resolve(root, logicalPath));
    if (!absolute.startsWith(root + path.sep))
      throw new Error(`Resource escapes package: ${logicalPath}`);
    let bytes;
    if (logicalPath === manifest.entry) {
      const result = await build({
        entryPoints: [absolute],
        absWorkingDir: root,
        bundle: true,
        platform: "browser",
        format: "iife",
        globalName: "VignetAssetLifecycle",
        target: "chrome135",
        write: false,
        legalComments: "inline",
        metafile: true,
      });
      for (const input of Object.keys(result.metafile.inputs)) {
        const resolved = await realpath(path.resolve(root, input));
        if (!resolved.startsWith(root + path.sep))
          throw new Error(`Script import escapes package: ${input}`);
      }
      bytes = result.outputFiles[0].contents;
    } else bytes = new Uint8Array(await readFile(absolute));
    files.push({ path: logicalPath, bytes });
  }
  manifest.integrity = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [file.path, await sha256(file.bytes)]),
    ),
  );
  const archive = await packPackage(manifest, files);
  // Run the same inspection as browser import before writing a distribution.
  const inspection = await inspectPackage(archive);
  if (destination) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, archive);
  }
  return { archive, inspection };
}

export async function packExamples(output = "dist/packages") {
  const results = [];
  for (const [directory, filename] of [
    ["packages/rain", "rain.vignet"],
    ["packages/example-theme", "example-theme.vignet"],
  ]) {
    const result = await packAsset(directory, path.join(output, filename));
    results.push({
      filename,
      bytes: result.archive.byteLength,
      assetId: result.inspection.manifest.id,
    });
  }
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [directory, output] = process.argv.slice(2);
  if (directory) {
    const result = await packAsset(
      directory,
      output ||
        path.join("dist/packages", `${path.basename(directory)}.vignet`),
    );
    console.log(
      `Packed ${result.inspection.manifest.id}: ${result.archive.byteLength} bytes`,
    );
  } else console.log(await packExamples());
}
