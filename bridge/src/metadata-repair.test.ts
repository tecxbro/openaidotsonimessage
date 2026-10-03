import { beforeEach, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Space } from '@spectrum-ts/core';
import { DATA_DIR, type OutboundItem } from './types.ts';
import { GpProofRuntime } from './runtime.ts';
import { enqueueOutbound, loadOutboundQueue, updateOutbound, loadPollMeta, loadAppCardSession } from './storage.ts';
import { loadPresentationByBatchId, PRESENTATIONS_DIR } from './reaction-option.ts';
beforeEach(async () => { await rm(DATA_DIR, { recursive: true, force: true }); await mkdir(DATA_DIR, { recursive: true }); });
type Probe = { spaces: Map<string, Space>; drainOutbound(): Promise<void>; sendOutbound(item: OutboundItem): Promise<void> };
function fixture() {
  let sends = 0, lookups = 0;
  const session = { chatGuid: 'chat', messageGuid: 'message', sessionId: 'session', targetMessageGuid: 'target' };
  const space = { id: 'space', send: async () => { sends++; return { id: 'accepted-app', miniAppCardSession: session }; }, getMessage: async () => { lookups++; return { id: 'accepted-app', miniAppCardSession: session }; }, stopTyping: async () => {} } as unknown as Space;
  const runtime = new GpProofRuntime({ projectId: 'fake', projectSecret: 'fake', authorizedSenderId: 'owner', hostMode: 'dot-local' });
  const probe = runtime as unknown as Probe; probe.spaces.set('space', space);
  return { runtime, probe, session, sends: () => sends, lookups: () => lookups };
}
test('accepted poll and card metadata missing after a crash is repaired without source files or sends', async () => {
  const f = fixture(), paths = [join(DATA_DIR, 'a.jpg'), join(DATA_DIR, 'b.jpg')];
  for (const path of paths) await writeFile(path, 'fixture');
  const [poll] = await enqueueOutbound({ kind: 'poll', spaceId: 'space', title: 'Choice?', options: ['A', 'B'] });
  const [group] = await enqueueOutbound({ kind: 'attachment_group', spaceId: 'space', attachmentPaths: paths, cards: [{ title: 'A' }, { title: 'B' }], batchId: 'cards' });
  for (const item of [poll!, group!]) await updateOutbound(item.id, { status: 'sent', deliveryState: 'provider_accepted', messageId: `accepted-${item.kind}`, providerAcceptedAt: new Date().toISOString() });
  for (const path of paths) await rm(path);
  try {
    await f.probe.drainOutbound();
    expect(await loadPollMeta('accepted-poll')).toEqual({ title: 'Choice?', options: ['A', 'B'] });
    expect((await loadPresentationByBatchId('cards'))?.parts.map(part => part.title)).toEqual(['A', 'B']);
    expect((await loadOutboundQueue()).find(row => row.id === group!.id)!.kind === 'attachment_group').toBe(true);
    expect(f.sends()).toBe(0);
  } finally { await f.runtime.stop(); }
});
test('failed app metadata write keeps SDK session evidence and is repaired on the same pump', async () => {
  const f = fixture(), metadata = join(DATA_DIR, 'app-card-sessions.json'); await mkdir(metadata);
  const [app] = await enqueueOutbound({ kind: 'app', spaceId: 'space', url: 'https://example.com', live: true });
  try {
    await f.probe.sendOutbound(app!);
    let row = (await loadOutboundQueue())[0]!;
    expect(row.status).toBe('sent'); expect(row.appSession).toEqual(f.session); expect(row.metadataPending).toBe(true);
    await rm(metadata, { recursive: true });
    await f.probe.drainOutbound();
    expect(await loadAppCardSession('accepted-app')).toEqual(f.session); expect(f.sends()).toBe(1);
    row = (await loadOutboundQueue())[0]!; expect(row.metadataPending).toBe(false);
  } finally { await f.runtime.stop(); }
});
test('legacy accepted app can recover its session through lookup; unavailable evidence remains pending', async () => {
  const f = fixture();
  const [app] = await enqueueOutbound({ kind: 'app', spaceId: 'space', url: 'https://example.com', live: true });
  await updateOutbound(app!.id, { status: 'sent', messageId: 'accepted-app', deliveryState: 'provider_accepted' });
  try { await f.probe.drainOutbound(); expect(await loadAppCardSession('accepted-app')).toEqual(f.session); expect(f.lookups()).toBe(1); expect(f.sends()).toBe(0); } finally { await f.runtime.stop(); }
});

test('missing accepted app session evidence stays pending without a resend', async () => {
  const f = fixture();
  (f.probe.spaces.get('space') as unknown as { getMessage(): Promise<undefined> }).getMessage = async () => undefined;
  const [app] = await enqueueOutbound({ kind: 'app', spaceId: 'space', url: 'https://example.com', live: true });
  await updateOutbound(app!.id, { status: 'sent', messageId: 'accepted-app', deliveryState: 'provider_accepted' });
  try { await f.probe.drainOutbound(); const row = (await loadOutboundQueue())[0]!; expect(row.status).toBe('sent'); expect(row.metadataPending).toBe(true); expect(row.appSession).toBeUndefined(); expect(f.sends()).toBe(0); } finally { await f.runtime.stop(); }
});
