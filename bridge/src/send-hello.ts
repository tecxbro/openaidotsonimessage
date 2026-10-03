/** Diagnostic messages use the durable queue and the existing provider owner. */
import { loadEnvFile } from './config.ts';
import { enqueueOutbound, loadConversationContext } from './storage.ts';

export async function enqueueDiagnosticGreeting(spaceId: string, authorizedSenderId: string) {
  const context = await loadConversationContext(spaceId);
  if (!authorizedSenderId.trim() || context?.senderId !== authorizedSenderId) throw new Error('unverified_conversation');
  return enqueueOutbound({ spaceId, text: 'got you. spectrum is online. text again anytime and i’ll see it live.' }, `diagnostic-hello:${spaceId}`);
}

if (import.meta.main) {
  loadEnvFile();
  const spaceId = process.argv[2], senderId = process.env.AUTHORIZED_SENDER_ID?.trim();
  if (!spaceId || !senderId) throw new Error('usage: AUTHORIZED_SENDER_ID=<owner> bun run src/send-hello.ts <verified-space-id>');
  console.log(JSON.stringify({ queued: await enqueueDiagnosticGreeting(spaceId, senderId), delivery: 'runtime-owned; inspect durable outbox for acceptance' }));
}
