/** Isolated instant-agent/provider benchmark. No credentials, network or device. */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Message, Space, Spectrum } from '@spectrum-ts/core';

const args = process.argv.slice(2);
const argument = (name: string) => args[args.indexOf(name) + 1];
const samples = args.includes('--samples') ? Number(argument('--samples')) : 100;
if (!Number.isInteger(samples) || samples < 10 || samples > 1000) throw new Error('samples_must_be_10_to_1000');
const externalAgent = args.includes("--external-agent");
const reportPath = args.includes('--report') ? argument('--report') : undefined;
const directory = await mkdtemp(join(tmpdir(), 'dot-instant-benchmark-'));
process.env.BRIDGE_DATA_DIR = directory;
const { GpProofRuntime } = await import('./runtime.ts');
const { waitForDotBatch } = await import('./dot-wait.ts');
const { replyToBatch } = await import('./dot-agent.ts');
const { loadOutboundQueue } = await import('./storage.ts');
const { markSetupConfettiSent } = await import('./setup-confetti.ts');
const { latencyKey } = await import('./latency.ts');
const backlog: Array<[Space, Message]> = [];
let waiter: ((result: IteratorResult<[Space, Message]>) => void) | undefined;
let ended = false, connections = 0, sends = 0;
let reads = 0, typingStarts = 0, typingStops = 0;
const space = { id: 'fake-space', type: 'dm', phone: 'fake-line', send: async () => ({ id: `fake-provider-${++sends}` }),
  startTyping: async () => { typingStarts++; }, stopTyping: async () => { typingStops++; },
} as unknown as Space;
const messages: AsyncIterable<[Space, Message]> = { [Symbol.asyncIterator]() {
  return { next: async () => {
    const value = backlog.shift();
    if (value) return { done: false, value };
    if (ended) return { done: true, value: undefined };
    return new Promise(resolve => { waiter = resolve; });
  } };
} };
const connect = (async () => {
  connections++;
  return { messages, stop: async () => { ended = true; waiter?.({ done: true, value: undefined }); waiter = undefined; } };
}) as unknown as typeof Spectrum;
const runtime = new GpProofRuntime({ projectId: 'fake', projectSecret: 'fake', authorizedSenderId: 'fake-owner', hostMode: 'dot-local', greetingFastPath: false }, connect);
const probe = runtime as unknown as { spaces: Map<string, Space> };
probe.spaces.set(space.id, space);
const recorded: Array<{ message: string; batch: string; outbound: string }> = [];
let running: Promise<void> | undefined;
async function until(check: () => Promise<boolean>) {
  const deadline = performance.now() + 5000;
  while (!await check()) { if (performance.now() > deadline) throw new Error('benchmark_timeout'); await Bun.sleep(1); }
}
try {
  await markSetupConfettiSent(); // Warm/onboarded fixture; not a production reset.
  running = runtime.start();
  await until(async () => Boolean(waiter));
  for (let i = 0; i < samples + 10; i++) {
    const id = `fake-input-${i}`;
    const message = { id, platform: 'imessage', direction: 'inbound', sender: { id: 'fake-owner' }, timestamp: new Date(), content: { type: 'text', text: 'benchmark request' }, read: async () => { reads++; } } as unknown as Message;
    const next = waiter; waiter = undefined;
    if (next) next({ done: false, value: [space, message] }); else backlog.push([space, message]);
    const claim = await waitForDotBatch('instant-agent', { timeoutMs: 5000 });
    if (claim.status !== 'claimed') throw new Error('benchmark_claim_failed');
    const request = { batchId: claim.batch.batchId, owner: 'instant-agent', actionId: 'answer', text: 'substantive benchmark result' };
    const reply = externalAgent ? await (async () => {
      const child = Bun.spawn([process.execPath, new URL('./dot-agent.ts', import.meta.url).pathname, 'reply'], { env: process.env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      child.stdin.write(JSON.stringify(request));
      child.stdin.end();
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      if (code !== 0) throw new Error('external_agent_failed');
      return JSON.parse(stdout) as Awaited<ReturnType<typeof replyToBatch>>;
    })() : await replyToBatch(request);
    if (!reply.outbound) throw new Error('benchmark_enqueue_failed');
    const outbound = reply.outbound[0]!;
    await until(async () => (await loadOutboundQueue()).find(item => item.id === outbound.id)?.status === 'sent');
    if (i >= 10) recorded.push({ message: latencyKey(id), batch: latencyKey(claim.batch.batchId), outbound: latencyKey(outbound.id) });
  }
  await runtime.stop(); await running;
  if (reads !== samples + 10 || typingStarts !== samples + 10 || typingStops < samples + 10) throw new Error('benchmark_controls_not_exercised');
  const rows = (await readFile(join(directory, 'latency.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { key: string; stage: string; atMs: number });
  const at = (key: string, stage: string) => {
    const row = rows.find(row => row.key === key && row.stage === stage);
    if (!row) throw new Error(`missing_boundary:${stage}`); return row.atMs;
  };
  const intervals = (reference: 'message' | 'batch' | 'outbound', from: string, to: string) => recorded.map(sample => at(sample[reference], to) - at(sample[reference], from)).sort((a, b) => a - b);
  const stats = (values: number[]) => ({ samples: values.length, p50Ms: +values[Math.ceil(values.length * .5) - 1]!.toFixed(3), p95Ms: +values[Math.ceil(values.length * .95) - 1]!.toFixed(3), maximumMs: +values.at(-1)!.toFixed(3) });
  const report = {
    fixture: 'local instant agent and provider; no network or device', agentProducer: externalAgent ? 'separate CLI process' : 'same process', measuredAt: new Date().toISOString(), runtime: `Bun ${Bun.version}`, platform: process.platform, warmupSamples: 10, connections, substantiveResponses: sends,
    controls: { enabled: true, reads, typingStarts, typingStops },
    inputCommitToPublication: stats(intervals('message', 'inboundCommittedAt', 'batchPublishedAt')),
    publicationToClaim: stats(intervals('batch', 'batchPublishedAt', 'claimedAt')),
    claimToAnswerSubmission: stats(intervals('batch', 'claimedAt', 'answerReadyAt')),
    outboxCommitToSdkInvocation: stats(intervals('outbound', 'outboxCommittedAt', 'sdkCallStartedAt')),
    sdkInvocationToFakeReturn: stats(intervals('outbound', 'sdkCallStartedAt', 'providerReturnedAt')),
  };
  if (reportPath) { await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime.stop(); if (running) await running;
  await rm(directory, { recursive: true, force: true });
}
