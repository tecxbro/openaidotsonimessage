import { sendReplyWithFallback, type ReplySpaceLike } from "./reply-fallback.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let fallbackCalls = 0;
const direct = await sendReplyWithFallback(
  {
    async getMessage() {
      return { async reply() { return { id: "reply" }; } };
    },
    async send() { fallbackCalls++; return { id: "fallback" }; },
  },
  "message-1",
  "hello",
);
assert(direct.status === "sent" && direct.mode === "reply", "uses reply when available");
assert(fallbackCalls === 0, "does not fallback after successful reply");

for (const space of [
  {
    async getMessage() { return undefined; },
    async send() { return { id: "fallback-missing" }; },
  },
  {
    async getMessage() {
      return { async reply() { return undefined; } };
    },
    async send() { return { id: "fallback-undefined" }; },
  },
] satisfies ReplySpaceLike[]) {
  const result = await sendReplyWithFallback(space, "poll-message", "ack");
  assert(result.status === "sent" && result.mode === "fallback", "falls back to space.send");
}

const undefinedFallback = await sendReplyWithFallback(
  {
    async getMessage() { return undefined; },
    async send() { return undefined; },
  },
  "missing",
  "ack",
);
assert(undefinedFallback.status === "failed", "undefined fallback is terminal failure");
assert(undefinedFallback.reason.includes("fallback space.send returned undefined"), "records undefined fallback");

const thrownFallback = await sendReplyWithFallback(
  {
    async getMessage() { return undefined; },
    async send() { throw new Error("send unavailable"); },
  },
  "missing",
  "ack",
);
assert(thrownFallback.status === "unknown", "thrown fallback is quarantined");
assert(thrownFallback.reason.includes("fallback space.send failed"), "records thrown fallback");

console.log("ALL_REPLY_FALLBACK_TESTS_PASSED");

let duplicateCalls = 0;
const ambiguous = await sendReplyWithFallback({
  async getMessage() { return { async reply() { throw new Error("timeout after send"); } }; },
  async send() { duplicateCalls++; return { id: "bad-duplicate" }; },
}, "original", "hello");
assert(ambiguous.status === "unknown", "unknown reply is quarantined");
assert(duplicateCalls === 0, "never duplicate ambiguous reply");

const { expect, test } = await import('bun:test');
test('a reply result without a usable message ID stays unknown and never falls back', async () => {
  let sends = 0;
  const result = await sendReplyWithFallback({ getMessage: async () => ({ reply: async () => ({ id: '' }) }), send: async () => { sends++; return { id: 'duplicate' }; } }, 'target', 'answer');
  expect(result.status).toBe('unknown'); expect(sends).toBe(0);
});
test('lifecycle cancellation before reply invocation propagates to the runtime', async () => {
  const result = sendReplyWithFallback({ getMessage: async () => ({ reply: async () => { throw new Error('runtime_stopping'); } }), send: async () => ({ id: 'bad' }) }, 'target', 'answer');
  await expect(result).rejects.toThrow('runtime_stopping');
});
