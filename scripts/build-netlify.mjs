import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ["index.html", "404.html", "robots.txt"]) {
  await cp(path.join(root, file), path.join(output, file));
}
console.log("Prepared the public site files in dist/. Backend code and local account data are excluded.");