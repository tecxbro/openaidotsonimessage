import type { InboundRecord } from "./types.ts";
import { attachmentDisplayText } from "./inbound-attachment.ts";

/** Minimal shape we read from Spectrum message.content. */
export type ContentLike = {
  type: string;
  text?: string;
  markdown?: string;
  content?: ContentLike;
  effect?: string;
  emoji?: string;
  target?: { id?: string };
  title?: string;
  selected?: boolean;
  option?: { title?: string };
  poll?: { type?: string; title?: string; options?: { title?: string }[] };
  options?: { title?: string }[];
  id?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  duration?: number;
  read?: () => Promise<Buffer | Uint8Array>;
};

export type ShapedInbound = {
  kind: "text" | "reaction" | "poll_vote" | "attachment" | "voice";
  text: string;
  emoji?: string;
  targetMessageId?: string;
  replyToMessageId?: string;
  effect?: string;
  reactionRemoved?: boolean;
  pollTitle?: string;
  pollOption?: string;
  pollSelected?: boolean;
  attachmentId?: string;
  attachmentName?: string;
  attachmentMimeType?: string;
  attachmentBytes?: number;
  /** True when content has a .read() we can download. */
  hasReadableBytes?: boolean;
  attachmentDuration?: number;
};

/** Spectrum iMessage 12.10.1 exposes these on the message, not its content. */
export type InboundMessageMetadata = {
  expressiveSendStyleId?: string;
  reactionRecord?: { selected?: boolean };
};

function inboundEnvelope(content: ContentLike | undefined): {
  content?: ContentLike;
  replyToMessageId?: string;
  effect?: string;
} {
  let replyToMessageId: string | undefined;
  let effect: string | undefined;
  const visited = new Set<ContentLike>();
  while (content?.type === "reply" || content?.type === "effect") {
    if (visited.has(content)) return {};
    visited.add(content);
    if (content.type === "reply" && !replyToMessageId && content.target?.id) {
      replyToMessageId = content.target.id;
    }
    if (content.type === "effect" && !effect && content.effect) {
      effect = content.effect;
    }
    content = content.content;
  }
  return { content, replyToMessageId, effect };
}

/** Return the original media leaf so its provider read() method is preserved. */
export function unwrapInboundContent(
  content: ContentLike | undefined,
): ContentLike | undefined {
  return inboundEnvelope(content).content;
}

/**
 * Shape inbound Spectrum content into a record payload Grok can read.
 * Returns null for unsupported kinds (caller may still mark handled).
 * Attachment/voice bytes are downloaded later by the runtime.
 */
export function shapeInboundContent(
  content: ContentLike | undefined,
  metadata?: InboundMessageMetadata,
): ShapedInbound | null {
  const envelope = inboundEnvelope(content);
  const shaped = shapeInboundLeaf(envelope.content);
  if (!shaped) return null;
  const effect = envelope.effect || metadata?.expressiveSendStyleId;
  const reactionSelected = metadata?.reactionRecord?.selected;
  return {
    ...shaped,
    ...(envelope.replyToMessageId
      ? { replyToMessageId: envelope.replyToMessageId }
      : {}),
    ...(effect ? { effect } : {}),
    // Universal Reaction content has no removal flag. The pinned live stream
    // emits additions only; preserve the provider's actual metadata if present.
    ...(shaped.kind === "reaction" && typeof reactionSelected === "boolean"
      ? {
          reactionRemoved: !reactionSelected,
          ...(reactionSelected ? {} : { text: `removed reaction ${shaped.emoji}` }),
        }
      : {}),
  };
}

function shapeInboundLeaf(
  content: ContentLike | undefined,
): ShapedInbound | null {
  if (!content) return null;

  if (content.type === "text" && typeof content.text === "string") {
    return { kind: "text", text: content.text };
  }
  if (content.type === "markdown" && typeof content.markdown === "string") {
    return { kind: "text", text: content.markdown };
  }
  if (content.type === "reaction") {
    const emoji =
      typeof content.emoji === "string" && content.emoji.length > 0
        ? content.emoji
        : "?";
    const targetMessageId =
      content.target && typeof content.target.id === "string"
        ? content.target.id
        : undefined;
    return {
      kind: "reaction",
      text: `reacted ${emoji}`,
      emoji,
      ...(targetMessageId ? { targetMessageId } : {}),
    };
  }
  if (content.type === "poll_option") {
    const optionTitle =
      (typeof content.title === "string" && content.title.trim()) ||
      (content.option && typeof content.option.title === "string"
        ? content.option.title.trim()
        : "") ||
      "?";
    const pollTitle =
      content.poll && typeof content.poll.title === "string"
        ? content.poll.title.trim()
        : undefined;
    const selected = content.selected !== false;
    const verb = selected ? "voted" : "unvoted";
    const text = pollTitle
      ? `${verb} ${optionTitle} on "${pollTitle}"`
      : `${verb} ${optionTitle}`;
    return {
      kind: "poll_vote",
      text,
      pollOption: optionTitle,
      pollSelected: selected,
      ...(pollTitle ? { pollTitle } : {}),
    };
  }
  if (content.type === "attachment" || content.type === "voice") {
    const isVoice = content.type === "voice";
    const name =
      typeof content.name === "string" && content.name.trim().length > 0
        ? content.name.trim()
        : isVoice
          ? "voice-note"
          : "attachment";
    const mimeType =
      typeof content.mimeType === "string" && content.mimeType.length > 0
        ? content.mimeType
        : isVoice
          ? "audio/mp4"
          : "application/octet-stream";
    const size =
      typeof content.size === "number" && content.size >= 0
        ? content.size
        : undefined;
    const duration =
      typeof content.duration === "number" && content.duration >= 0
        ? content.duration
        : undefined;
    const label = isVoice
      ? `[voice] ${name} (${mimeType}${size !== undefined ? `, ${size} bytes` : ""}${duration !== undefined ? `, ${duration}s` : ""})`
      : attachmentDisplayText(name, mimeType, size);
    return {
      kind: isVoice ? "voice" : "attachment",
      text: label,
      attachmentName: name,
      attachmentMimeType: mimeType,
      ...(typeof content.id === "string" && content.id
        ? { attachmentId: content.id }
        : {}),
      ...(size !== undefined ? { attachmentBytes: size } : {}),
      ...(duration !== undefined ? { attachmentDuration: duration } : {}),
      hasReadableBytes: typeof content.read === "function",
    };
  }
  // Echo of a poll we (or someone) created — not a user reply; ignore for wake.
  if (content.type === "poll") {
    return null;
  }
  // Inbound read receipts (recipient read our outbound) — not a user message.
  if (content.type === "read") {
    return null;
  }
  return null;
}

export function toInboundRecord(
  shaped: ShapedInbound,
  meta: {
    id: string;
    spaceId: string;
    senderId: string;
    timestamp: string;
    receivedAt: string;
  },
  extras?: {
    attachmentPath?: string;
    attachmentBytes?: number;
    attachmentOriginalPath?: string;
    attachmentOriginalMimeType?: string;
    transcript?: string;
  },
): InboundRecord {
  return {
    id: meta.id,
    spaceId: meta.spaceId,
    senderId: meta.senderId,
    text: shaped.text,
    timestamp: meta.timestamp,
    receivedAt: meta.receivedAt,
    kind: shaped.kind,
    ...(shaped.emoji ? { emoji: shaped.emoji } : {}),
    ...(shaped.targetMessageId
      ? { targetMessageId: shaped.targetMessageId }
      : {}),
    ...(shaped.replyToMessageId
      ? { replyToMessageId: shaped.replyToMessageId }
      : {}),
    ...(shaped.effect ? { effect: shaped.effect } : {}),
    ...(shaped.reactionRemoved !== undefined
      ? { reactionRemoved: shaped.reactionRemoved }
      : {}),
    ...(shaped.pollTitle ? { pollTitle: shaped.pollTitle } : {}),
    ...(shaped.pollOption ? { pollOption: shaped.pollOption } : {}),
    ...(shaped.pollSelected !== undefined
      ? { pollSelected: shaped.pollSelected }
      : {}),
    ...(shaped.attachmentId ? { attachmentId: shaped.attachmentId } : {}),
    ...(shaped.attachmentName ? { attachmentName: shaped.attachmentName } : {}),
    ...(shaped.attachmentMimeType
      ? { attachmentMimeType: shaped.attachmentMimeType }
      : {}),
    ...(extras?.attachmentPath
      ? { attachmentPath: extras.attachmentPath }
      : {}),
    ...(extras?.attachmentBytes !== undefined
      ? { attachmentBytes: extras.attachmentBytes }
      : shaped.attachmentBytes !== undefined
        ? { attachmentBytes: shaped.attachmentBytes }
        : {}),
    ...(extras?.attachmentOriginalPath
      ? { attachmentOriginalPath: extras.attachmentOriginalPath }
      : {}),
    ...(extras?.attachmentOriginalMimeType
      ? { attachmentOriginalMimeType: extras.attachmentOriginalMimeType }
      : {}),
    ...(shaped.attachmentDuration !== undefined
      ? { attachmentDuration: shaped.attachmentDuration }
      : {}),
    ...(extras?.transcript ? { transcript: extras.transcript } : {}),
  };
}
