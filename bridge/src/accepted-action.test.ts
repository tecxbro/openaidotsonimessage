import { beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './types.ts';
import { enqueueOutbound, loadOutboundQueue } from './storage.ts';
beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
test('authorized unchanged accepted group retries need no source files and preserve canonical hashing and array order', async () => {
  const paths = [join(DATA_DIR, 'a.jpg'), join(DATA_DIR, 'b.jpg')];
  for (const path of paths) await writeFile(path, 'synthetic');
  const input = { kind: 'attachment_group' as const, spaceId: 'space', attachmentPaths: paths, cards: [{ title: 'A', optionId: 'a' }, { title: 'B', optionId: 'b' }] };
  const original = await enqueueOutbound(input, 'stable');
  for (const path of paths) await rm(path);
  let authorized = 0;
  const retry = await enqueueOutbound({ cards: input.cards.map(card => ({ optionId: card.optionId, title: card.title })), attachmentPaths: paths, spaceId: 'space', kind: 'attachment_group' }, 'stable', async () => { authorized++; });
  expect(retry).toEqual(original); expect(authorized).toBe(1);
  await expect(enqueueOutbound({ ...input, attachmentPaths: [...paths].reverse(), cards: [...input.cards].reverse() }, 'stable')).rejects.toThrow('idempotency_key_content_mismatch');
  await expect(enqueueOutbound(input, 'stable', async () => { throw new Error('not_authorized'); })).rejects.toThrow('not_authorized');
  expect(await loadOutboundQueue()).toEqual(original);
});
test('accepted attachment and voice retries reuse original identity after temporary files disappear', async () => {
  const path = join(DATA_DIR, 'temporary.txt'); await writeFile(path, 'fixture');
  const text = { spaceId: 'space', text: '[attachment]', attachmentPath: path };
  const voice = { kind: 'voice' as const, spaceId: 'space', audioPath: path };
  const a = await enqueueOutbound(text, 'text'), b = await enqueueOutbound(voice, 'voice');
  await rm(path);
  expect(await enqueueOutbound(text, 'text')).toEqual(a);
  expect(await enqueueOutbound(voice, 'voice')).toEqual(b);
});
