// WS-21 (plan r2 I3): EVERY ROUTER CONSUMER OF THE HOME, DECIDED — proved on a FRESH home.
//
// On a home Migration C has never touched there are no compatibility links: `<home>/projects` does not
// exist, and the canonical store is `<home>/sdk/projects`. A Winter → claude → Winter switch must find
// the transcript there at every step (step 4's settle, step 5's validation, step 8's staging and the
// Winter destination's resume path), while the handoff leases stay under the daemon's own home.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WINTER_BRAND, WinterCompatibilitySessionStore, envName, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import { createRuntimeSdk, runtimeSdkInternals, sdkHomeOf, type RuntimeSdkPeers } from "../../src/index.ts";
import { canonicalTranscriptPath, resolveEngineTempLayout, type HandoffSourceOwner, type HandoffStepReport, type SharedSessionStore } from "../../src/store/index.ts";
import { createInMemoryRuntimeDirectoryStore, type RuntimeDirectoryEntry } from "../../src/seams/directory-store.ts";
import type { RuntimeKind, RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { RESUME_STAGING_PREFIX } from "../../src/vendor-paths.ts";
import { cleanupRunHomeBeds, runHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);

const OK: HandoffStepReport = { ok: true };

const selectionFor = (runtimeKind: RuntimeKind): RuntimeSelection => ({
  runtimeKind,
  providerId: runtimeKind === "claude-agent" ? "anthropic" : "openai",
  modelRef: runtimeKind === "claude-agent" ? "anthropic/claude-sonnet-4-5" : "openai/gpt-5",
  family: runtimeKind === "claude-agent" ? "claude" : "gpt",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "the fresh-home handoff bed",
  decidedAt: new Date(0).toISOString(),
});

describe("a Winter → claude → Winter switch on a fresh WS-21 home", () => {
  test("the barrier finds the canonical transcript in sdk/projects at every step; nothing is written to <home>/projects", async () => {
    const bed = runHomeBed("handoff");
    const home = bed.home;
    const tempBase = join(bed.root, "temp");
    const directoryStore = createInMemoryRuntimeDirectoryStore();
    const key: SessionKey = { projectKey: "-ws21-fresh", sessionId: "11111111-2222-4333-8444-555555555555" };
    const { peer } = createFakeWinterPeer();
    const peers = {
      winter: {
        ...peer,
        WinterCompatibilitySessionStore,
        resolveWinterHome: () => {
          throw new Error("a hermetic test must never resolve the real Winter home");
        },
      } as unknown as RuntimeSdkPeers["winter"],
    };
    const confirmedBy: RuntimeKind[] = [];
    const sdk = createRuntimeSdk({
      peers,
      keychain: createFakeKeychain(),
      directoryStore,
      requireRunHome: true,
      handoff: {
        winterHome: home,
        stagingRootFor: (uuid) => join(bed.root, "staging", `${RESUME_STAGING_PREFIX}${uuid}`),
        tempLayoutFor: () => {
          mkdirSync(tempBase, { recursive: true });
          return resolveEngineTempLayout({ brand: WINTER_BRAND, tempProjectKey: key.projectKey, backendUuid: key.sessionId, uid: 4242, env: { [envName(WINTER_BRAND, "TMPDIR")]: tempBase } });
        },
        participants: {
          source: (_session, from) => ({ runtimeKind: from, drainToIdleBoundary: () => OK, drainStream: () => OK, close: () => OK }) as HandoffSourceOwner,
          destination: (_session, to) => ({
            runtimeKind: to,
            confirmInit: () => {
              confirmedBy.push(to);
              return OK;
            },
          }),
        },
      },
    });
    const shared = (runtimeSdkInternals(sdk)!.barrier as unknown as { shared: SharedSessionStore }).shared;
    expect(shared.identity.storeHome).toBe(sdkHomeOf(home));
    expect(shared.identity.winterHome).toBe(home);

    // A Winter session with two turns in the canonical store.
    const entry: RuntimeDirectoryEntry = {
      address: "session:s_fresh",
      parsed: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "s_fresh", backendSessionId: key.sessionId },
      runtimeKind: "winter-agent",
      objectKind: "session",
      transport: "winter-session",
      status: "idle",
      mode: "code",
      generation: 1,
      selection: selectionFor("winter-agent"),
      backendSessionId: key.sessionId,
      capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
      updatedAt: new Date().toISOString(),
    };
    await directoryStore.upsert(entry);
    let parent: string | null = null;
    const entries: SessionStoreEntry[] = [];
    for (let i = 0; i < 2; i += 1) {
      const uuid = randomUUID();
      entries.push({ type: "user", uuid, parentUuid: parent, sessionId: key.sessionId, timestamp: new Date().toISOString(), cwd: bed.cwd, version: "0.0.0", isSidechain: false, message: { role: "user", content: `turn ${i}` } });
      parent = uuid;
    }
    await shared.store.append(key, entries);
    await shared.settle(key);

    const canonical = canonicalTranscriptPath(sdkHomeOf(home), key);
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(join(home, "projects"))).toBe(false);

    const toClaude = await sdk.handoff(key, "claude-agent");
    expect(toClaude.kind).toBe("resumed");
    if (toClaude.kind !== "resumed") throw new Error("unreachable");
    // Step 8 staged the resume copy FROM the store's own root.
    const staged = (toClaude as { target?: { resumePath: string } }).target!.resumePath;
    expect(readFileSync(staged, "utf8")).toContain("turn 1");

    const toWinter = await sdk.handoff(key, "winter-agent");
    expect(toWinter.kind).toBe("resumed");
    // A Winter destination resumes the canonical file itself — the shared runtime home's, never <home>/projects.
    expect((toWinter as { target?: { resumePath: string } }).target!.resumePath).toBe(canonical);

    expect(confirmedBy).toEqual(["claude-agent", "winter-agent"]);
    expect(existsSync(join(home, "projects"))).toBe(false);
    // The leases stayed under the daemon's own home.
    expect(existsSync(join(home, "runtimes", "handoff-leases"))).toBe(true);
    expect(existsSync(join(sdkHomeOf(home), "runtimes"))).toBe(false);
  });
});
