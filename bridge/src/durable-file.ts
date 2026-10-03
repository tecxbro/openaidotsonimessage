/** Publish state only after file contents and the directory entry are synced. */
import { mkdir, open, rename, rm, link } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function writeContents(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
}
export async function writeExclusiveFile(path: string, body: string, beforePublish: () => void = () => {}): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeContents(temporary, body);
    beforePublish();
    // Atomic exclusive publication of already-synced contents. Unlike opening
    // the final path with wx, readers can never see its partially written body.
    await link(temporary, path);
    await syncDirectory(path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
export async function atomicWriteFile(path: string, body: string, beforePublish: () => void = () => {}): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeContents(temporary, body);
    beforePublish();
    await rename(temporary, path);
    await syncDirectory(path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
