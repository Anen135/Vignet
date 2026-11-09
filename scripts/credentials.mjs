import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const operatorDirectory = path.join(
  process.env.LOCALAPPDATA ||
    process.env.XDG_CONFIG_HOME ||
    path.join(homedir(), ".config"),
  "Vignet",
);

export async function ownerCredentials(
  filename = process.env.VIGNETTE_CONFIG ||
    path.join(operatorDirectory, "credentials.json"),
) {
  await mkdir(path.dirname(filename), { recursive: true });
  let credentials;
  try {
    credentials = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    credentials = {
      apiToken: randomBytes(32).toString("hex"),
      deviceToken: randomBytes(32).toString("hex"),
    };
    try {
      await writeFile(filename, JSON.stringify(credentials, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      credentials = JSON.parse(await readFile(filename, "utf8"));
    }
  }
  for (const key of ["apiToken", "deviceToken"]) {
    if (typeof credentials[key] !== "string" || credentials[key].length < 32)
      throw new Error(`Invalid ${key} in operator config`);
  }
  return { filename, credentials };
}
