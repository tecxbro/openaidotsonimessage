/** Agent-authored actions only: no LLM, auto-answering server, or extra provider. */
import { readFile } from 'node:fs/promises';
import { pendingDotBatches } from './dot-inbox.ts';
import { waitForDotBatch } from './dot-wait.ts';
import { tryClaimBatch, markBatchClaimCompleted, readBatchClaim, withLiveBatchClaim, assertLiveBatchClaim } from './batch-claim.ts';
import { enqueueOutbound, readUnreadBatch, loadOutboundQueue, validateId } from './storage.ts';
import type { EnqueueOutboundInput } from './types.ts';

type ActionRequest = { actionId: string; input: EnqueueOutboundInput };
type DirectReplyRequest = { batchId: string; owner: string; actionId: string; text: string };

/** Shared by the action-file and direct-text paths: never skip queue validation. */
async function enqueueBatchAction(batchId: string, owner: string, request: ActionRequest) {
  await assertLiveBatchClaim(batchId, owner);
  const batch = await readUnreadBatch(batchId);
  validateId(request.actionId);
  if (!batch.messages.some(m => m.spaceId === request.input.spaceId)) throw new Error('original_batch_space_required');
  if (request.input.kind === 'reply' || request.input.kind === 'react' || request.input.kind === 'app_update') {
    const target = request.input.targetMessageId;
    const sourceKnown = batch.messages.some(m => m.spaceId === request.input.spaceId && (m.id === target || m.replyToMessageId === target || m.targetMessageId === target));
    const outgoingKnown = (await loadOutboundQueue()).some(item => item.spaceId === request.input.spaceId &&
      (item.messageId === target || (item.kind === 'attachment_group' && item.parts?.some(part => part.childId === target))));
    if (!sourceKnown && !outgoingKnown) throw new Error('target_not_verified_in_original_conversation');
  }
  return withLiveBatchClaim(batchId, owner, () => enqueueOutbound(request.input, `${batchId}:${request.actionId}`, () => assertLiveBatchClaim(batchId, owner)));
}

function parseDirectReply(raw: string): DirectReplyRequest {
  const request: unknown = JSON.parse(raw);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('reply_request_object_required');
  const fields = ['batchId', 'owner', 'actionId', 'text'] as const;
  if (Object.keys(request).some(key => !fields.some(field => field === key))) throw new Error('unsupported_reply_field');
  for (const field of fields) {
    if (!(field in request) || typeof (request as Record<string, unknown>)[field] !== 'string') throw new Error(`reply_${field}_string_required`);
  }
  const reply = request as DirectReplyRequest;
  validateId(reply.batchId);
  validateId(reply.actionId);
  if (!reply.owner.trim()) throw new Error('owner_required');
  return reply;
}

/** A retry must keep actionId and text unchanged. Completion is queue acceptance,
 * not delivery; completed claims return already_completed without a new send. */
async function replyToBatch(request: DirectReplyRequest) {
  const { batchId, owner, actionId, text } = request;
  const existing = await readBatchClaim(batchId);
  if (existing?.state === 'completed' && existing.owner === owner) {
    return { ok: false, reason: 'already_completed', claim: existing };
  }
  await assertLiveBatchClaim(batchId, owner);
  const batch = await readUnreadBatch(batchId);
  const spaces = [...new Set(batch.messages.map(message => message.spaceId))];
  if (spaces.length !== 1 || !spaces[0]?.trim()) throw new Error('single_original_batch_space_required');
  const outbound = await enqueueBatchAction(batchId, owner, { actionId, input: { kind: 'text', spaceId: spaces[0], text } });
  // Never complete in a finally block: any enqueue rejection must leave the
  // claim unfinished so the same logical action can be safely retried.
  const claim = await markBatchClaimCompleted(batchId, owner, `${actionId} accepted by queue`);
  return { ok: true, claim, outbound };
}

const [action, batchId, owner, arg] = process.argv.slice(2).filter(x => x !== '--');
let result: unknown;
if (action === 'reply' && batchId === undefined) {
  result = await replyToBatch(parseDirectReply(await Bun.stdin.text()));
} else if (action === 'wait' && batchId) {
  const timeoutMs = owner === undefined ? 30_000 : Number(owner);
  result = await waitForDotBatch(batchId, { timeoutMs });
} else if (action === 'pending') {
  result = await pendingDotBatches();
} else if (action === 'status') {
  result = { pending: (await pendingDotBatches()).map(x => x.batchId), outbound: await loadOutboundQueue(), activation: 'active-task-only' };
} else if (action === 'claim' && batchId && owner) {
  const batch = await readUnreadBatch(batchId);
  const claim = await tryClaimBatch(batchId, owner);
  result = claim.ok ? { ...claim, batch } : claim;
} else if (action === 'complete' && batchId && owner) {
  result = await markBatchClaimCompleted(batchId, owner, arg);
} else if (action === 'enqueue' && batchId && owner && arg) {
  // Check the claim before reading an action file, as the original CLI did.
  await assertLiveBatchClaim(batchId, owner);
  result = await enqueueBatchAction(batchId, owner, JSON.parse(await readFile(arg, 'utf8')) as ActionRequest);
} else {
  throw new Error('usage: dot-agent reply < stdin JSON {batchId,owner,actionId,text} | wait <owner> [timeout-ms]|pending|status|claim <batchId> <owner>|complete <batchId> <owner> [note]|enqueue <batchId> <owner> <action.json>');
}
console.log(JSON.stringify(result, null, 2));
