import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

async function scripts(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = `${directory}/${item.name}`;
    if (item.isDirectory()) result.push(...(await scripts(filename)));
    else if (/\.(mjs|js)$/.test(item.name)) result.push(filename);
  }
  return result;
}
let count = 0;
for (const directory of [
  "bridge",
  "extension",
  "scripts",
  "tests",
  "packages",
]) {
  for (const filename of await scripts(directory)) {
    const result = spawnSync(process.execPath, ["--check", filename], {
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(1);
    count++;
  }
}
console.log(`Syntax PASS: ${count} JavaScript files`);
