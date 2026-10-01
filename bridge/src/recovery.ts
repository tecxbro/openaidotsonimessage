import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, type InboundRecord, type UnreadBatch } from './types.ts';
import { addHandledId, addWebhookPending, loadPendingBatch, savePendingBatch, loadOutboundQueue, updateOutbound } from './storage.ts';
import { assertRecoveryTimestamp, type RecoveryPolicy } from './recovery-policy.ts';
export async function recoverDurableState(policy?: RecoveryPolicy): Promise<InboundRecord[]> {
  const covered = new Set<string>();
  for (const name of await readdir(join(DATA_DIR, 'unread')).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const batch: UnreadBatch = JSON.parse(await readFile(join(DATA_DIR, 'unread', name), 'utf8'));
    if (policy) batch.messages.forEach(m => assertRecoveryTimestamp(policy, m.timestamp));
    batch.messages.forEach(m => covered.add(m.id));
    if (!batch.handledBy) await addWebhookPending(batch.batchId);
  }
  const buffered = await loadPendingBatch();
  if (policy) buffered.forEach(m => assertRecoveryTimestamp(policy, m.timestamp));
  const pending = new Map(buffered.filter(m => !covered.has(m.id)).map(m => [m.id, m]));
  for (const name of await readdir(join(DATA_DIR, 'inbound')).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    const record: InboundRecord = JSON.parse(await readFile(join(DATA_DIR, 'inbound', name), 'utf8'));
    if (policy) assertRecoveryTimestamp(policy, record.timestamp);
    if (!covered.has(record.id)) pending.set(record.id, record);
    await addHandledId(record.id);
  }
  const records = [...pending.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  await savePendingBatch(records);
  for (const item of await loadOutboundQueue()) {
    if (item.status === 'sending') await updateOutbound(item.id, { status: 'unknown', deliveryState: 'unknown', lastError: 'process_stopped_during_send' });
  }
  return records;
}
