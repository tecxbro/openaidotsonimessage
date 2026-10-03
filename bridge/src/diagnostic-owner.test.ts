import { beforeEach, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { DATA_DIR, type OutboundItem } from './types.ts';
import { loadOutboundQueue, saveConversationContext } from './storage.ts';
beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
test('diagnostic greeting requires the original conversation and queues through the runtime owner', async () => {
  // Inspect before importing the old executable: its import opened a real
  // provider. Reproducing that prohibited side effect must stay offline.
  const source = await Bun.file(new URL('./send-hello.ts', import.meta.url)).text();
  expect(source.includes('await Spectrum(')).toBe(false);
  const { enqueueDiagnosticGreeting } = await import('./send-hello.ts') as unknown as { enqueueDiagnosticGreeting(spaceId: string, authorizedSenderId: string): Promise<OutboundItem[]> };
  await expect(enqueueDiagnosticGreeting('space', 'owner')).rejects.toThrow('unverified_conversation');
  await saveConversationContext('space', { senderId: 'owner' });
  await expect(enqueueDiagnosticGreeting('space', 'wrong-owner')).rejects.toThrow('unverified_conversation');
  const original = await enqueueDiagnosticGreeting('space', 'owner');
  expect(await enqueueDiagnosticGreeting('space', 'owner')).toEqual(original);
  expect(await loadOutboundQueue()).toHaveLength(1); expect(original[0]!.status).toBe('queued');
});
