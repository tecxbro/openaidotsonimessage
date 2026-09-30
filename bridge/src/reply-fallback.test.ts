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
