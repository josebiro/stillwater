import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function readEnhancedNotes(bundle: string) {
  const path = join(bundle, "enhanced.md");
  try {
    if (!(await lstat(path)).isFile()) throw new Error("Invalid enhanced notes file");
    const bytes = await readFile(path);
    return { text: bytes.toString("utf8"), revision: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { text: "", revision: null };
  }
}

export class EnhancedNotesConflict extends Error {
  readonly current: Awaited<ReturnType<typeof readEnhancedNotes>>;
  constructor(current: Awaited<ReturnType<typeof readEnhancedNotes>>) {
    super("Enhanced notes changed on disk.");
    this.current = current;
  }
}

export async function saveEnhancedNotes(bundle: string, text: string, revision: string | null) {
  const target = join(bundle, "enhanced.md");
  const temporary = join(bundle, `.enhanced-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: "wx", flush: true });
    const current = await readEnhancedNotes(bundle);
    if (current.revision !== revision) {
      throw new EnhancedNotesConflict(current);
    }
    await rename(temporary, target);
    return await readEnhancedNotes(bundle);
  } finally {
    await rm(temporary, { force: true });
  }
}
