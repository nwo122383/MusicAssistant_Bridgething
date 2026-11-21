import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = async path => JSON.parse(await readFile(resolve(root, path), "utf8"));
const pkg = await json("package.json");
const manifest = await json("dist/manifest.json");
const catalog = await json("docs/catalog.v1.json");
if (pkg.version !== manifest.version) throw new Error("Package and built manifest versions differ");
if (catalog.schema !== "catalog.v1") throw new Error("Unexpected catalog schema");
const app = catalog.apps.find(app => app.id === manifest.id);
if (!app) throw new Error("Built app UUID is not in the catalog");
const version = app.versions.find(version => version.version === pkg.version);
if (!version?.changelog || !version.min_libbridgething_version) throw new Error("Add this version's changelog and minimum BridgeThing version to the catalog first");
if (!/^\d+\.\d+\.\d+$/.test(version.min_libbridgething_version)) throw new Error("Invalid minimum BridgeThing version");
if (manifest.permissions.some(permission => !version.permissions.includes(permission))) throw new Error("Catalog permissions do not cover the bundle");

const filename = `${pkg.name}-v${pkg.version}.zip`;
const archive = resolve(root, "release", filename);
const bytes = await readFile(archive);
const baseUrl = new URL("docs/", `https://raw.githubusercontent.com/${new URL(app.source).pathname.slice(1).replace(/\.git$/, "")}/main/`);
await copyFile(archive, resolve(root, "docs", filename));
version.download = { url: new URL(filename, baseUrl).href, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };

if (manifest.settings) {
  const settings = await readFile(resolve(root, "dist", manifest.settings));
  const settingsFilename = `${pkg.name}-v${pkg.version}-settings.html`;
  await writeFile(resolve(root, "docs", settingsFilename), settings);
  version.settings = { url: new URL(settingsFilename, baseUrl).href, size: settings.length, sha256: createHash("sha256").update(settings).digest("hex") };
}

version.released_at = new Date().toISOString();
catalog.updated_at = version.released_at;
app.versions.sort((a, b) => Date.parse(b.released_at) - Date.parse(a.released_at));
await writeFile(resolve(root, "docs/catalog.v1.json"), `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Prepared ${filename} (${version.download.size} bytes)`);
console.log(`SHA-256 ${version.download.sha256}`);
console.log("Updated catalog download and hosted settings metadata");
