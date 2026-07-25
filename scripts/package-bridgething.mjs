import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { deflateRawSync } from "node:zlib";
import packageJson from "../package.json" with { type: "json" };

const root = new URL("..", import.meta.url).pathname;
const distDir = join(root, "dist");
const releaseDir = join(root, "release");
const packageName = `${packageJson.name}-bridgething-v${packageJson.version}.zip`;
const outputPath = join(releaseDir, packageName);

const crcTable = new Uint32Array(256);
for (let i = 0; i < crcTable.length; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[i] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function writeUInt16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function writeUInt32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function buildZip(files) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const file of files) {
    const data = await readFile(file);
    const info = await stat(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const name = relative(distDir, file).split(sep).join("/");
    const nameBuffer = Buffer.from(name);
    const crc = crc32(data);
    const { time, date } = dosDateTime(info.mtime);
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(8),
      writeUInt16(time),
      writeUInt16(date),
      writeUInt32(crc),
      writeUInt32(compressed.length),
      writeUInt32(data.length),
      writeUInt16(nameBuffer.length),
      writeUInt16(0),
      nameBuffer,
    ]);

    chunks.push(localHeader, compressed);
    centralDirectory.push(Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(8),
      writeUInt16(time),
      writeUInt16(date),
      writeUInt32(crc),
      writeUInt32(compressed.length),
      writeUInt32(data.length),
      writeUInt16(nameBuffer.length),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(0),
      writeUInt32(offset),
      nameBuffer,
    ]));
    offset += localHeader.length + compressed.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centralDirectory);
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(files.length),
    writeUInt16(files.length),
    writeUInt32(central.length),
    writeUInt32(centralStart),
    writeUInt16(0),
  ]);

  return Buffer.concat([...chunks, central, end]);
}

const files = (await listFiles(distDir)).filter((file) => !file.endsWith(".map")).sort();
if (!files.some((file) => basename(file) === "manifest.json")) {
  throw new Error("dist/manifest.json is missing. Run npm run build:bridgething first.");
}

await mkdir(releaseDir, { recursive: true });
await writeFile(outputPath, await buildZip(files));
console.log(`Wrote ${relative(root, outputPath)}`);
