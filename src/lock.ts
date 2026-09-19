/**
 * The vendor-skills lockfile (vendor-skills.lock).
 *
 * The lockfile records exactly which git commit each installed skill came
 * from, so an agent environment can be reproduced bit-for-bit later — the
 * same role package-lock.json plays for npm. It is meant to be committed
 * alongside the vendored skills. Reads tolerate a missing file (empty lock);
 * writes are atomic (temp file + rename) so a crash never leaves a
 * half-written lock behind.
 */
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const LOCK_FILE_NAME = "vendor-skills.lock";

export interface LockSource {
  /** The git URL (or local path) the skill was installed from. */
  git: string;
  /** Path inside the repository that contains the skill, when applicable. */
  subdir?: string;
  /** The commit the skill was installed at. */
  commit: string;
}

export interface LockEntry {
  name: string;
  source: LockSource;
  /** ISO 8601 timestamp. */
  installedAt: string;
}

export interface LockFile {
  version: 1;
  skills: LockEntry[];
}

export function lockPath(root: string): string {
  return join(root, LOCK_FILE_NAME);
}

function isLockFile(value: unknown): value is LockFile {
  if (typeof value !== "object" || value === null) return false;
  const skills = (value as Record<string, unknown>)["skills"];
  return Array.isArray(skills);
}

/** Read the lockfile under `root`; a missing file yields an empty lock. */
export async function readLock(root: string): Promise<LockFile> {
  let text: string;
  try {
    text = await readFile(lockPath(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, skills: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${LOCK_FILE_NAME} at ${lockPath(root)} is not valid JSON; fix or delete it and re-install.`,
    );
  }
  if (!isLockFile(parsed)) {
    throw new Error(
      `${LOCK_FILE_NAME} at ${lockPath(root)} is malformed (expected { version, skills: [] }); fix or delete it and re-install.`,
    );
  }
  return { version: 1, skills: parsed.skills };
}

/** Atomically write the lockfile under `root` (temp file + rename). */
export async function writeLock(root: string, lock: LockFile): Promise<void> {
  await mkdir(root, { recursive: true });
  const target = lockPath(root);
  const tmp = join(root, `.vendor-skills.lock.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, JSON.stringify(lock, null, 2) + "\n", "utf8");
  await rename(tmp, target);
}
