import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import {
  applyResolvedOptionToInbound,
  buildAttachmentGroupParts,
  cardsFromOutboundItem,
  formatChildId,
  loadPresentationByMessageId,
  optionNamesFromParts,
  parseChildTargetId,
  persistAttachmentGroupMapping,
  PRESENTATION_INDEX_PATH,
  PRESENTATIONS_DIR,
  resolveReactionOption,
  savePresentation,
  type PresentationRecord,
} from "./reaction-option.ts";
import type { InboundRecord } from "./types.ts";
import { enqueueOutbound, updateOutbound } from "./storage.ts";

const FIXTURE_ROOT = "/tmp/gpproof-reaction-option-test";

describe("formatChildId / parseChildTargetId", () => {
  test("round-trips Spectrum p:N/guid", () => {
    const id = formatChildId(5, "spc-msg-00000000-0000-4000-8000-000000000001");
    expect(id).toBe("p:5/spc-msg-00000000-0000-4000-8000-000000000001");
    expect(parseChildTargetId(id)).toEqual({
      partIndex: 5,
      parentGuid: "spc-msg-00000000-0000-4000-8000-000000000001",
    });
  });

  test("rejects non-child targets", () => {
    expect(parseChildTargetId("spc-msg-abc")).toBeNull();
    expect(parseChildTargetId("")).toBeNull();
    expect(parseChildTargetId("p:x/guid")).toBeNull();
  });
});

describe("buildAttachmentGroupParts", () => {
  test("keeps all seven cards with existing details, price qualifiers, and exact links", () => {
    const parts = buildAttachmentGroupParts({
      parentMessageId: "seven-card-parent",
      paths: Array.from({ length: 7 }, (_, i) => `/card-${i}.png`),
      cards: Array.from({ length: 7 }, (_, i) => ({
        optionId: `card-${i}`,
        title: `Card ${i}`,
        details: "  Original researched details  ",
        caption: "Original caption",
        price: i === 6 ? undefined : "  From $125/night, before tax  ",
        url: `https://hotel.example/rooms/${i}?dates=original`,
      })),
    });
    expect(parts).toHaveLength(7);
    expect(parts[5]).toMatchObject({
      details: "Original researched details",
      caption: "Original caption",
      price: "From $125/night, before tax",
      url: "https://hotel.example/rooms/5?dates=original",
      childId: "p:5/seven-card-parent",
    });
    expect(parts[6]!.price).toBeUndefined();
  });

  test("maps paths + cards to childIds", () => {
    const parts = buildAttachmentGroupParts({
      parentMessageId: "spc-msg-parent",
      paths: ["/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg"],
      cards: [
        { title: "A", url: "https://a.example", optionId: "a" },
        { title: "B", url: "https://b.example" },
        { title: "C" },
        { caption: "D only caption" },
      ],
    });
    expect(parts).toHaveLength(4);
    expect(parts[0]).toMatchObject({
      partIndex: 0,
      childId: "p:0/spc-msg-parent",
      optionId: "a",
      title: "A",
      url: "https://a.example",
    });
    expect(parts[3]!.title).toBeUndefined();
    expect(parts[3]!.caption).toBe("D only caption");
  });
});

describe("persist + resolve", () => {
  const batchId = "{{DEPLOY_ID_PREFIX}}-b-test-reaction-opt";
  const parentId = "spc-msg-test-parent-guid";

  beforeEach(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    mkdirSync(PRESENTATIONS_DIR, { recursive: true });
    // Clean any prior test presentation/index entries for this batch
    const pres = join(PRESENTATIONS_DIR, `${batchId}.json`);
    if (existsSync(pres)) rmSync(pres, { force: true });
  });

  afterEach(() => {
    const pres = join(PRESENTATIONS_DIR, `${batchId}.json`);
    if (existsSync(pres)) rmSync(pres, { force: true });
    if (existsSync(PRESENTATION_INDEX_PATH)) {
      try {
        const index = JSON.parse(readFileSync(PRESENTATION_INDEX_PATH, "utf8")) as {
          byMessageId: Record<string, unknown>;
        };
        if (index.byMessageId?.[parentId]) {
          delete index.byMessageId[parentId];
          writeFileSync(
            PRESENTATION_INDEX_PATH,
            `${JSON.stringify(index, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        }
      } catch {
        // ignore
      }
    }
  });

  test("persistAttachmentGroupMapping writes presentation + index", async () => {
    const { parts, presentationPath } = await persistAttachmentGroupMapping({
      outboundId: "{{DEPLOY_ID_PREFIX}}-o-test-1",
      spaceId: "any;-;+1000",
      parentMessageId: parentId,
      batchId,
      paths: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg", "/tmp/d.jpg"],
      cards: [
        { title: "GrandMarc Studio A", url: "https://gm.example/a", optionId: "gm-a" },
        { title: "GrandMarc 1x1", url: "https://gm.example/b", optionId: "gm-b" },
        { title: "Sterling House A2", url: "https://st.example", optionId: "sterling" },
        { title: "Diplomat 2BR", url: "https://dip.example", optionId: "diplomat" },
      ],
    });
    expect(existsSync(presentationPath)).toBe(true);
    expect(parts[2]!.childId).toBe(`p:2/${parentId}`);

    const loaded = await loadPresentationByMessageId(parentId);
    expect(loaded).not.toBeNull();
    expect(loaded!.batchId).toBe(batchId);
    expect(loaded!.parts).toHaveLength(4);
    expect(loaded!.parts[0]!.title).toBe("GrandMarc Studio A");

    const index = JSON.parse(readFileSync(PRESENTATION_INDEX_PATH, "utf8")) as {
      byMessageId: Record<string, { batchId: string }>;
    };
    expect(index.byMessageId[parentId]?.batchId).toBe(batchId);
  });

  test("resolveReactionOption returns option for p:N/guid", async () => {
    await persistAttachmentGroupMapping({
      outboundId: "{{DEPLOY_ID_PREFIX}}-o-test-2",
      spaceId: "any;-;+1000",
      parentMessageId: parentId,
      batchId,
      paths: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg", "/tmp/d.jpg"],
      cards: [
        { title: "A", url: "https://a", optionId: "a" },
        { title: "B", url: "https://b", optionId: "b" },
        { title: "C", url: "https://c", optionId: "c" },
        { title: "D", url: "https://d", optionId: "d" },
      ],
    });

    const hit = await resolveReactionOption(`p:2/${parentId}`);
    expect(hit.ambiguous).toBe(false);
    if (!hit.ambiguous) {
      expect(hit.partIndex).toBe(2);
      expect(hit.title).toBe("C");
      expect(hit.optionId).toBe("c");
      expect(hit.url).toBe("https://c");
      expect(hit.batchId).toBe(batchId);
    }
  });

  test("missing map → ambiguous with empty or listed names — never guesses", async () => {
    const miss = await resolveReactionOption("p:1/spc-msg-does-not-exist");
    expect(miss.ambiguous).toBe(true);
    if (miss.ambiguous) {
      expect(miss.reason).toBe("missing-presentation");
      expect(miss.optionNames).toEqual([]);
    }

    // Parent-only target against a known presentation → batch-only ambiguous
    await persistAttachmentGroupMapping({
      outboundId: "{{DEPLOY_ID_PREFIX}}-o-test-3",
      spaceId: "any;-;+1000",
      parentMessageId: parentId,
      batchId,
      paths: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg", "/tmp/d.jpg"],
      cards: [
        { title: "Alpha" },
        { title: "Beta" },
        { title: "Gamma" },
        { title: "Delta" },
      ],
    });
    const batchOnly = await resolveReactionOption(parentId);
    expect(batchOnly.ambiguous).toBe(true);
    if (batchOnly.ambiguous) {
      expect(batchOnly.reason).toBe("batch-only-target");
      expect(batchOnly.optionNames).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    }
  });

  test("part without identity → ambiguous with optionNames", async () => {
    const record: PresentationRecord = {
      batchId,
      spaceId: "s",
      messageId: parentId,
      savedAt: new Date().toISOString(),
      parts: [
        { partIndex: 0, path: "/a.jpg", childId: formatChildId(0, parentId), title: "Named" },
        { partIndex: 1, path: "/b.jpg", childId: formatChildId(1, parentId) }, // no identity
      ],
    };
    await savePresentation(record);
    const r = await resolveReactionOption(`p:1/${parentId}`);
    expect(r.ambiguous).toBe(true);
    if (r.ambiguous) {
      expect(r.reason).toBe("part-missing-option-identity");
      expect(r.optionNames).toEqual(["Named"]);
    }
  });

  test("applyResolvedOptionToInbound enriches Front Door fields", async () => {
    await persistAttachmentGroupMapping({
      outboundId: "{{DEPLOY_ID_PREFIX}}-o-test-4",
      spaceId: "any;-;+1000",
      parentMessageId: parentId,
      batchId,
      paths: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg", "/tmp/d.jpg"],
      cards: [
        { title: "Windsor", url: "https://w", optionId: "windsor" },
        { title: "Avalon", url: "https://a", optionId: "avalon" },
        { title: "Brick", url: "https://b", optionId: "brick" },
        { title: "Mariposa", url: "https://m", optionId: "mariposa" },
      ],
    });
    const base: InboundRecord = {
      id: `${parentId}:reaction:1:1`,
      spaceId: "any;-;+1000",
      senderId: "+1000",
      text: "reacted ❤️",
      timestamp: "2026-09-26T00:00:00.000Z",
      receivedAt: "2026-09-26T00:00:01.000Z",
      kind: "reaction",
      emoji: "❤️",
      targetMessageId: `p:1/${parentId}`,
    };
    const resolved = await resolveReactionOption(base.targetMessageId);
    const enriched = applyResolvedOptionToInbound(base, resolved);
    expect(enriched.optionAmbiguous).toBe(false);
    expect(enriched.reactedPartIndex).toBe(1);
    expect(enriched.optionTitle).toBe("Avalon");
    expect(enriched.optionId).toBe("avalon");
    expect(enriched.optionUrl).toBe("https://a");
    expect(enriched.text).toBe('reacted ❤️ on "Avalon"');
    expect(enriched.reactedChildId).toBe(`p:1/${parentId}`);
  });

  test("optionNamesFromParts prefers title then optionId", () => {
    expect(
      optionNamesFromParts([
        { title: "T" },
        { optionId: "oid" },
        { path: "/x" },
      ]),
    ).toEqual(["T", "oid"]);
  });

  test("any emoji retains saved details, known price, and original direct URL", async () => {
    await persistAttachmentGroupMapping({
      outboundId: "card-details-send",
      spaceId: "any;-;+1000",
      parentMessageId: parentId,
      batchId,
      paths: ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"],
      cards: [
        {
          optionId: "known-option",
          title: "Known hotel",
          caption: "Ocean view",
          details: "King bed; breakfast included",
          price: "From $219/night, excluding tax",
          url: "https://hotel.example/room?offer=original",
        },
        { title: "Price not supplied", url: "https://hotel.example/unknown" },
        { title: "Third" }, { title: "Fourth" }, { title: "Fifth" },
      ],
    });
    const resolved = await resolveReactionOption(`p:0/${parentId}`);
    for (const emoji of ["❤️", "👍", "👎", "❓", "🌵", "🦄"]) {
      const record: InboundRecord = {
        id: `reaction-${emoji}`,
        spaceId: "any;-;+1000",
        senderId: "+1000",
        timestamp: "2026-09-30T00:00:00.000Z",
        receivedAt: "2026-09-30T00:00:01.000Z",
        kind: "reaction",
        emoji,
        text: `reacted ${emoji}`,
        targetMessageId: `p:0/${parentId}`,
      };
      expect(applyResolvedOptionToInbound(record, resolved)).toMatchObject({
        emoji,
        optionAmbiguous: false,
        optionDetails: "King bed; breakfast included",
        optionPrice: "From $219/night, excluding tax",
        optionCaption: "Ocean view",
        optionUrl: "https://hotel.example/room?offer=original",
      });
      const removed = applyResolvedOptionToInbound({
        ...record,
        text: `removed reaction ${emoji}`,
        reactionRemoved: true,
      }, resolved);
      expect(removed.reactionRemoved).toBe(true);
      expect(removed.text).toBe(`removed reaction ${emoji}`);
    }
    const unknownPrice = await resolveReactionOption(`p:1/${parentId}`);
    expect(unknownPrice.ambiguous).toBe(false);
    if (!unknownPrice.ambiguous) {
      expect(unknownPrice.price).toBeUndefined();
      expect(unknownPrice.details).toBeUndefined();
    }
  });

  test("outbound queue fallback retains full card metadata without a presentation file", async () => {
    const queueParentId = `${parentId}-queue-fallback`;
    const [item] = await enqueueOutbound({
      kind: "attachment_group",
      spaceId: "reaction-option-queue-test",
      attachmentPaths: Array(4).fill("/tmp/gpproof-1x1.png"),
      cards: Array.from({ length: 4 }, (_, i) => ({
        title: `Option ${i}`,
        details: `Existing details ${i}`,
        price: i === 0 ? "$40 total" : undefined,
        url: `https://option.example/${i}`,
      })),
    });
    expect(item?.kind).toBe("attachment_group");
    if (!item || item.kind !== "attachment_group") throw new Error("missing group");
    const cards = cardsFromOutboundItem(item);
    expect(cards[0]!.price).toBe("$40 total");
    await updateOutbound(item.id, {
      messageId: queueParentId,
      status: "sent",
      parts: buildAttachmentGroupParts({
        parentMessageId: queueParentId,
        paths: item.attachmentPaths,
        cards,
      }),
    });
    const resolved = await resolveReactionOption(`p:0/${queueParentId}`);
    expect(resolved).toMatchObject({
      ambiguous: false,
      details: "Existing details 0",
      price: "$40 total",
      url: "https://option.example/0",
    });
  });
});
