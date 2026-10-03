/** Offline operator action. No credentials, provider, or retry authorization. */
import { reconcileCorruptBatchClaim } from './batch-claim.ts';
const [batchId, owner] = process.argv.slice(2);
if (!batchId || !owner) throw new Error('usage: bun run src/reconcile-claim.ts <batchId> <original-owner>');
console.log(JSON.stringify(await reconcileCorruptBatchClaim(batchId, owner), null, 2));
