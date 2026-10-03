/** Best-effort timing evidence cannot fail an accepted logical action. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './types.ts';
export const LATENCY_STAGES = ['streamReceivedAt', 'inboundCommittedAt', 'batchPublishedAt', 'claimedAt', 'answerReadyAt', 'outboxCommittedAt', 'sdkCallStartedAt', 'providerReturnedAt'] as const;
export type LatencyStage = typeof LATENCY_STAGES[number];
export const latencyNow = () => performance.timeOrigin + performance.now();
export const latencyKey = (reference: string) => createHash('sha256').update(reference).digest('hex');
export function recordLatency(stage: LatencyStage, reference: string, atMs = latencyNow()): void {
  if (!LATENCY_STAGES.includes(stage) || !Number.isFinite(atMs)) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(join(DATA_DIR, 'latency.jsonl'), JSON.stringify({ stage, key: latencyKey(reference), at: new Date(atMs).toISOString(), atMs }) + '\n', { mode: 0o600 });
  } catch { /* Observation never invalidates durable acceptance or authorizes retry. */ }
}
