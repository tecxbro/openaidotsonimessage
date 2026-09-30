export type ReplyTargetLike = { reply(text: string): Promise<unknown | undefined> };
export type ReplySpaceLike = {
  getMessage(messageId: string): Promise<ReplyTargetLike | undefined>;
  send(text: string): Promise<unknown | undefined>;
};
export type ReplyDeliveryResult =
  | { status: 'sent'; mode: 'reply' | 'fallback'; replyError?: string; messageId?: string; providerReturnedAt: string }
  | { status: 'failed'; reason: string }
  | { status: 'unknown'; reason: string };
const messageId = (value: unknown): string | undefined => {
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id;
};
/** Fallback is safe only before a send, or after a documented unsupported skip.
 * A thrown send can have reached the provider: never duplicate it automatically. */
export async function sendReplyWithFallback(space: ReplySpaceLike, targetMessageId: string, text: string): Promise<ReplyDeliveryResult> {
  let target: ReplyTargetLike | undefined;
  try { target = await space.getMessage(targetMessageId); } catch { /* lookup cannot send */ }
  let replyError = 'target message unavailable';
  if (target) {
    let sent: unknown;
    try { sent = await target.reply(text); } catch {
      return { status: 'unknown', reason: 'reply send outcome unknown' };
    }
    if (sent !== undefined) return { status: 'sent', mode: 'reply', messageId: messageId(sent), providerReturnedAt: new Date().toISOString() };
    replyError = 'reply returned undefined';
  }
  try {
    const sent = await space.send(text);
    if (sent !== undefined) return { status: 'sent', mode: 'fallback', replyError, messageId: messageId(sent), providerReturnedAt: new Date().toISOString() };
    return { status: 'failed', reason: `${replyError}; fallback space.send returned undefined` };
  } catch {
    return { status: 'unknown', reason: `${replyError}; fallback space.send failed with unknown outcome` };
  }
}
