import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EMPTY_BUYBACK,
  normalizeBuyback,
  type BuybackData,
} from "./buyback";

/**
 * File IO for the hand-maintained buyback ledger (server-only).
 *
 * `data/buyback.json` is the single source of truth on this deployment — the
 * admin panel writes it through `PUT /api/buyback`, `/treasury` reads it through
 * `GET /api/buyback`. No Prisma model, no migration: the file is the schema.
 *
 * The write is atomic (temp file + rename) so a crash mid-save can never leave a
 * half-written ledger behind. On a read-only filesystem (serverless deploys ship
 * the repo immutable) the write fails with a plain-language error instead of an
 * opaque EROFS — there the ledger has to be edited in the repo and redeployed.
 */

/** Absolute path resolved at request time, so `next start` from the repo root works. */
const FILE = path.join(process.cwd(), "data", "buyback.json");

/** Repo-relative path for UI copy / error messages. */
export const BUYBACK_FILE_LABEL = "data/buyback.json";

/**
 * Read the ledger. A missing file means "nothing recorded yet" (empty ledger);
 * a malformed one throws with the offending field paths, because silently
 * pretending the ledger is empty would hide a bad hand-edit.
 */
export async function readBuyback(): Promise<BuybackData> {
  let raw: string;
  try {
    raw = await fs.readFile(FILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_BUYBACK;
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${BUYBACK_FILE_LABEL} is not valid JSON.`);
  }

  const { data, errors } = normalizeBuyback(parsed);
  const bad = Object.keys(errors);
  if (bad.length > 0) {
    throw new Error(
      `${BUYBACK_FILE_LABEL} failed validation (${bad.slice(0, 3).join(", ")}${
        bad.length > 3 ? ", …" : ""
      }).`
    );
  }
  return data;
}

/**
 * Persist an already-validated ledger and stamp `updatedAt`.
 * Callers (the API route) run `normalizeBuyback` first so a 400 can carry the
 * per-field errors instead of a thrown exception.
 */
export async function writeBuyback(data: BuybackData): Promise<BuybackData> {
  const next: BuybackData = { ...data, updatedAt: new Date().toISOString() };
  try {
    await fs.mkdir(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await fs.rename(tmp, FILE);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EROFS" || code === "EACCES" || code === "EPERM") {
      throw new Error(
        `${BUYBACK_FILE_LABEL} is read-only on this deployment — edit the file in the repo (or on a writable host) instead.`
      );
    }
    throw e;
  }
  return next;
}
