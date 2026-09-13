// WS-18 W18-14 / P10b-6 R7 — `claudeReadyStore`: `load()` alone changes, everything else passes through.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { endpointFromOrigin, type ContinuityEndpoint } from "@yanlinglabs/winter-provider-runtime";
import type { SessionKey, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import { canonicalTranscriptPath } from "../../src/store/index.ts";
import { claudeReadyStore } from "../../src/official/claude-ready-store.ts";
import { withStoreBed } from "../store/support.ts";

const TARGET: ContinuityEndpoint = endpointFromOrigin({ providerId: "anthropic", modelKey: "anthropic/claude-opus-5", family: "claude" });

describe("WS-18 W18-14 — claudeReadyStore", () => {
  test("load() returns toClaudeReady(canonical) — proven non-vacuous: message.id is stamped where the canonical entry lacks one", async () => {
    await withStoreBed(async (bed) => {
      const uuid = randomUUID();
      const entry: SessionStoreEntry = {
        type: "assistant",
        uuid,
        parentUuid: null,
        sessionId: bed.key.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: "/lane-r7",
        version: "0.0.0",
        isSidechain: false,
        // NO `message.id`/`message.type` — the shape `toClaudeReady`'s step (b) stamps.
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      };
      await bed.shared.store.append(bed.key, [entry]);
      await bed.shared.settle(bed.key);

      const raw = (await bed.shared.store.load(bed.key)) ?? [];
      expect((raw[0]?.["message"] as { id?: unknown } | undefined)?.id).toBeUndefined();

      const wrapped = claudeReadyStore(bed.shared.store, { readSidecar: async () => [], resolveEndpoint: endpointFromOrigin, target: TARGET });
      const ready = (await wrapped.load(bed.key)) ?? [];
      const readyMessage = ready[0]?.["message"] as { id?: unknown; type?: unknown } | undefined;
      expect(readyMessage?.id).toBe(`msg_winter_${uuid.replaceAll("-", "")}`);
      expect(readyMessage?.type).toBe("message");
      // The uuid is preserved — `toClaudeReady` never changes an entry's identity.
      expect(ready[0]?.["uuid"]).toBe(uuid);
    });
  });

  test("load() returns null for a session with nothing canonical — there is nothing to make Claude-ready", async () => {
    await withStoreBed(async (bed) => {
      const wrapped = claudeReadyStore(bed.shared.store, { readSidecar: async () => [], resolveEndpoint: endpointFromOrigin, target: TARGET });
      const unknown: SessionKey = { projectKey: bed.key.projectKey, sessionId: randomUUID() };
      expect(await wrapped.load(unknown)).toBeNull();
    });
  });

  test("append passes through byte-identical — the wrapper never rewrites what it is given", async () => {
    await withStoreBed(async (bed) => {
      const wrapped = claudeReadyStore(bed.shared.store, { readSidecar: async () => [], resolveEndpoint: endpointFromOrigin, target: TARGET });
      const entries = [bed.entry()];
      await wrapped.append(bed.key, entries);
      await bed.shared.settle(bed.key);
      const raw = (await bed.shared.store.load(bed.key)) ?? [];
      expect(raw).toEqual(entries);
    });
  });

  test("the canonical file is UNCHANGED after a load — toClaudeReady is a pure in-memory fold, never a write", async () => {
    await withStoreBed(async (bed) => {
      await bed.append(2);
      const path = canonicalTranscriptPath(bed.home, bed.key);
      const before = readFileSync(path);
      const wrapped = claudeReadyStore(bed.shared.store, { readSidecar: async () => [], resolveEndpoint: endpointFromOrigin, target: TARGET });
      await wrapped.load(bed.key);
      expect(readFileSync(path)).toEqual(before);
    });
  });

  test("every other SessionStore member passes through unchanged, present or absent exactly as the underlying store declares it", async () => {
    await withStoreBed(async (bed) => {
      await bed.append(1);
      const wrapped = claudeReadyStore(bed.shared.store, { readSidecar: async () => [], resolveEndpoint: endpointFromOrigin, target: TARGET });
      // The shared store declares all four optional members — the wrapper must too, and delegate.
      expect(typeof wrapped.listSessions).toBe("function");
      expect(typeof wrapped.listSessionSummaries).toBe("function");
      expect(typeof wrapped.delete).toBe("function");
      expect(typeof wrapped.listSubkeys).toBe("function");
      const sessions = await wrapped.listSessions!(bed.key.projectKey);
      expect(sessions.some((s) => s.sessionId === bed.key.sessionId)).toBe(true);

      // A store that declares NONE of them — the wrapper must not invent any.
      const minimal = { append: async () => {}, load: async () => null };
      const wrappedMinimal = claudeReadyStore(minimal, { readSidecar: async () => [], resolveEndpoint: endpointFromOrigin, target: TARGET });
      expect(wrappedMinimal.listSessions).toBeUndefined();
      expect(wrappedMinimal.listSessionSummaries).toBeUndefined();
      expect(wrappedMinimal.delete).toBeUndefined();
      expect(wrappedMinimal.listSubkeys).toBeUndefined();
    });
  });
});
