import { unzipSync, zipSync, strToU8 } from "fflate";
import { error, safePath, validateManifest } from "./model.js";

export const PACKAGE_LIMITS = {
  archive: 16 * 1024 * 1024,
  unpacked: 32 * 1024 * 1024,
  files: 256,
  ratio: 100,
};
export async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
function invalid(message) {
  throw error("INVALID_PACKAGE", message);
}
const decoder = new TextDecoder("utf-8", { fatal: true });
function text(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    invalid("Text files must be valid UTF-8");
  }
}
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function inspectZip(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length > PACKAGE_LIMITS.archive ||
    bytes.length < 22
  )
    invalid("Archive size is invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    view.getUint32(end, true) !== 0x06054b50
  )
    end--;
  if (end < Math.max(0, bytes.length - 65557)) invalid("Missing ZIP directory");
  if (
    end + 22 + view.getUint16(end + 20, true) !== bytes.length ||
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true)
  )
    invalid("Multi-volume/trailing ZIP not supported");
  const count = view.getUint16(end + 10, true),
    directorySize = view.getUint32(end + 12, true),
    offset = view.getUint32(end + 16, true);
  if (
    count !== view.getUint16(end + 8, true) ||
    !count ||
    count > PACKAGE_LIMITS.files ||
    offset + directorySize !== end
  )
    invalid("Invalid ZIP directory size/count");
  const entries = [];
  const names = new Set();
  let pos = offset;
  let total = 0;
  let previousEnd = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50)
      invalid("Malformed ZIP entry");
    const flags = view.getUint16(pos + 8, true),
      method = view.getUint16(pos + 10, true),
      crc = view.getUint32(pos + 16, true),
      compressed = view.getUint32(pos + 20, true),
      size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true),
      extra = view.getUint16(pos + 30, true),
      comment = view.getUint16(pos + 32, true),
      local = view.getUint32(pos + 42, true);
    if (pos + 46 + nameLen + extra + comment > end)
      invalid("Truncated ZIP entry");
    const name = text(bytes.subarray(pos + 46, pos + 46 + nameLen));
    if (!safePath(name) || names.has(name.toLowerCase()))
      invalid(`Unsafe or duplicate path: ${name}`);
    names.add(name.toLowerCase());
    const unixType = (view.getUint32(pos + 38, true) >>> 16) & 0xf000;
    if (unixType && unixType !== 0x8000)
      invalid("Only regular files are allowed");
    if (
      flags & ~0x808 ||
      ![0, 8].includes(method) ||
      (size && (!compressed || size / compressed > PACKAGE_LIMITS.ratio))
    )
      invalid("Unsupported ZIP encoding or compression ratio");
    total += size;
    if (total > PACKAGE_LIMITS.unpacked) invalid("Unpacked size exceeds limit");
    if (
      local + 30 > offset ||
      view.getUint32(local, true) !== 0x04034b50 ||
      local < previousEnd
    )
      invalid("Invalid/overlapping ZIP local entry");
    const localNameLength = view.getUint16(local + 26, true),
      localExtra = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameLength + localExtra;
    if (
      dataStart + compressed > offset ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method ||
      text(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name
    )
      invalid("ZIP local metadata mismatch");
    if (
      !(flags & 8) &&
      (view.getUint32(local + 18, true) !== compressed ||
        view.getUint32(local + 22, true) !== size ||
        view.getUint32(local + 14, true) !== crc)
    )
      invalid("ZIP sizes mismatch");
    previousEnd = dataStart + compressed;
    entries.push({ name, size, crc });
    pos += 46 + nameLen + extra + comment;
  }
  if (pos !== end) invalid("Invalid ZIP central directory");
  return { entries, total };
}
export function detectMime(path, bytes) {
  const ext = path.split(".").pop().toLowerCase();
  const starts = (...v) => v.every((b, i) => bytes[i] === b);
  const ascii = (offset, len) =>
    String.fromCharCode(...bytes.subarray(offset, offset + len));
  if (["js", "css", "json", "txt"].includes(ext)) {
    text(bytes);
    return {
      js: "text/javascript",
      css: "text/css",
      json: "application/json",
      txt: "text/plain",
    }[ext];
  }
  if (ext === "png" && starts(137, 80, 78, 71, 13, 10, 26, 10))
    return "image/png";
  if (["jpg", "jpeg"].includes(ext) && starts(255, 216, 255))
    return "image/jpeg";
  if (ext === "webp" && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP")
    return "image/webp";
  if (ext === "ico" && starts(0, 0, 1, 0)) return "image/x-icon";
  if (
    ext === "mp3" &&
    (ascii(0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224))
  )
    return "audio/mpeg";
  if (ext === "wav" && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE")
    return "audio/wav";
  if (ext === "ogg" && ascii(0, 4) === "OggS") return "audio/ogg";
  if (ext === "svg") {
    const svg = text(bytes);
    // SVG is only exposed as an image; reject active features even in image context.
    if (
      !/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg) ||
      /<!|<\s*(?:script|foreignObject|iframe|object|embed|a|animate|set)\b|\bon[a-z]+\s*=|(?:href\s*=|url\s*\(|@import|javascript:|data:)/i.test(
        svg,
      )
    )
      invalid("Active or externally referenced SVG is forbidden");
    return "image/svg+xml";
  }
  invalid(`Unsupported file type or signature: ${path}`);
}
export async function inspectPackage(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { entries, total } = inspectZip(bytes);
  let data;
  try {
    data = unzipSync(bytes);
  } catch {
    invalid("ZIP decompression failed");
  }
  for (const entry of entries)
    if (
      !data[entry.name] ||
      data[entry.name].length !== entry.size ||
      crc32(data[entry.name]) !== entry.crc
    )
      invalid("ZIP size/checksum mismatch");
  if (!data["asset.json"]) invalid("asset.json required");
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(text(data["asset.json"])));
  } catch (e) {
    if (e.code) throw e;
    invalid("Invalid asset.json");
  }
  if (manifest.id.startsWith("builtin."))
    invalid("Built-in asset IDs are reserved");
  const references = new Set(
    [
      manifest.entry,
      ...manifest.scripts,
      ...manifest.styles,
      ...manifest.media,
    ].filter(Boolean),
  );
  for (const path of references)
    if (!data[path]) invalid(`Missing declared resource: ${path}`);
  const files = [];
  for (const { name } of entries) {
    if (name === "asset.json") continue;
    if (!references.has(name)) invalid(`Undeclared resource: ${name}`);
    const mime = detectMime(name, data[name]);
    const hash = await sha256(data[name]);
    if (manifest.integrity?.[name] && manifest.integrity[name] !== hash)
      throw error("INTEGRITY_MISMATCH", `Integrity mismatch: ${name}`);
    files.push({ path: name, bytes: data[name], mime, hash });
  }
  for (const path of Object.keys(manifest.integrity || {}))
    if (!references.has(path)) invalid("Integrity references missing resource");
  return { manifest, files, totalSize: total };
}
export async function packPackage(manifest, files) {
  const validated = validateManifest(manifest);
  const zip = Object.create(null);
  zip["asset.json"] = strToU8(JSON.stringify(validated, null, 2));
  for (const file of files) {
    if (
      !safePath(file.path) ||
      file.path === "asset.json" ||
      Object.hasOwn(zip, file.path)
    )
      invalid("Invalid or duplicate package path");
    zip[file.path] = file.bytes;
  }
  const bytes = zipSync(zip, { level: 6 });
  await inspectPackage(bytes);
  return bytes;
}
