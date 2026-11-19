import { open } from "node:fs/promises";

function versionParts(version: unknown) {
  if (typeof version !== "string" || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
    throw new Error("Expected a stable release version such as 1.2.3.");
  }
  return version.split(".").map(Number);
}

export async function checkLocalRelease(path: string, installed: string) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size > 4096) throw new Error("The release manifest is too large.");
    const manifest = JSON.parse((await file.readFile("utf8")).replace(/^\uFEFF/, ""));
    const current = versionParts(installed);
    const release = versionParts(manifest?.version);
    const difference = release.map((part, index) => part - current[index]).find((part) => part !== 0) ?? 0;
    return { version: String(manifest.version), available: difference > 0 };
  } finally {
    await file.close();
  }
}
