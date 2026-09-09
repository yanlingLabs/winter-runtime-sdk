// WS-05 §6 + WS-14 §5: one store, one version, and a mirror that behaves the way §5 pins it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { WinterCompatibilitySessionStore, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import {
  assertOneSharedStore,
  assertStoreCompatibleOptions,
  BlindStoreImportError,
  createDecorationRegistry,
  createSharedSessionStore,
  DEFAULT_MIRROR_POLICY,
  guardedImportSessionToStore,
  SharedStoreOptionsError,
  SharedStoreUnavailableError,
  stripDecorations,
} from "../../src/store/index.ts";
import type { SharedSessionStore } from "../../src/store/index.ts";
import { createFakeWinterPeer } from "../../src/testing/index.ts";
import { storePeers, withStoreBed } from "./support.ts";

describe("the shared store (WS-05 §6)", () => {
  test("both branches are handed the SAME object, and two stores over one home are refused", async () => {
    await withStoreBed(async (bed) => {
      const winterOptions = bed.shared.attach({} as { sessionStore?: unknown });
      const officialOptions = bed.shared.attach({ cwd: "/x" } as { cwd: string; sessionStore?: unknown });
      expect(winterOptions.sessionStore).toBe(bed.shared.store);
      expect(officialOptions.sessionStore).toBe(bed.shared.store);
      // Identity, not shape: this is the whole point of §6's "the identical package/version".
      expect(() => assertOneSharedStore(bed.shared, winterOptions, officialOptions)).not.toThrow();

      const second = createSharedSessionStore({ peers: bed.peers, winterHome: bed.home });
      expect(second.store).not.toBe(bed.shared.store);
      expect(() => assertOneSharedStore(bed.shared, second.attach({}))).toThrow(SharedStoreOptionsError);
      expect(() => assertOneSharedStore(bed.shared, {})).toThrow(SharedStoreOptionsError);
    });
  });

  test("the store class comes from the INJECTED peer, and a peer without one refuses loudly", () => {
    const { peer } = createFakeWinterPeer();
    expect(() => createSharedSessionStore({ peers: { winter: peer }, winterHome: "/nowhere" })).toThrow(SharedStoreUnavailableError);
  });

  test("the identity records the version BOTH branches are therefore on", async () => {
    await withStoreBed(async (bed) => {
      expect(bed.shared.identity.packageName).toBe("@yanlinglabs/winter-agent-sdk");
      expect(bed.shared.identity.packageVersion).toBe("0.0.2");
      expect(bed.shared.identity.winterHome).toBe(bed.home);
      expect(bed.shared.canonical).toBeInstanceOf(WinterCompatibilitySessionStore);
    });
  });

  test("WS-14 §5.1's two combinations are refused with a TYPED error, before either branch exists", async () => {
    await withStoreBed(async (bed) => {
      expect(() => bed.shared.attach({ persistSession: false })).toThrow(SharedStoreOptionsError);
      expect(() => bed.shared.attach({ enableFileCheckpointing: true })).toThrow(SharedStoreOptionsError);
      try {
        assertStoreCompatibleOptions({ persistSession: false, sessionStore: bed.shared.store });
        throw new Error("unreachable");
      } catch (error) {
        expect((error as SharedStoreOptionsError).option).toBe("persistSession");
        expect((error as Error).message).toContain("mirror");
      }
      // The combinations the SDK's own `query()` accepts are still accepted here.
      expect(bed.shared.attach({ persistSession: true }).sessionStore).toBe(bed.shared.store);
    });
  });
});

describe("the mirror's semantics (WS-14 §5)", () => {
  test("the defaults ARE §5's numbers", () => {
    expect(DEFAULT_MIRROR_POLICY).toEqual({ batchWindowMs: 100, maxAttempts: 3, backoffMs: 25, attemptTimeoutMs: 5_000 });
  });

  test("appends inside one ~100 ms window commit as ONE canonical append", async () => {
    const appends: number[] = [];
    class Counting extends WinterCompatibilitySessionStore {
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        appends.push(entries.length);
        return super.append(key, entries);
      }
    }
    await withStoreBed(
      async (bed) => {
        await bed.shared.store.append(bed.key, [bed.entry()]);
        await bed.shared.store.append(bed.key, [bed.entry()]);
        await bed.shared.store.append(bed.key, [bed.entry()]);
        expect(appends).toEqual([]); // nothing has reached the store yet — that is what a batch IS
        const settled = await bed.shared.settle(bed.key);
        expect(appends).toEqual([3]);
        expect(settled.batchesCommitted).toBe(1);
        expect(bed.shared.health(bed.key).appendsReceived).toBe(3);
        expect(((await bed.shared.store.load(bed.key)) ?? []).length).toBe(3);
      },
      { store: Counting },
    );
  });

  test("a failing append is retried at most three times, and then recorded rather than thrown", async () => {
    let attempts = 0;
    class AlwaysFails extends WinterCompatibilitySessionStore {
      override async append(): Promise<void> {
        attempts += 1;
        throw new Error("disk is on fire");
      }
    }
    await withStoreBed(
      async (bed) => {
        // §5: "MUST NOT retroactively fail the model turn" — the caller's promise resolves.
        await expect(bed.shared.store.append(bed.key, [bed.entry()])).resolves.toBeUndefined();
        const settled = await bed.shared.settle(bed.key);
        expect(attempts).toBe(3);
        expect(settled.transcriptHealth).toBe("repair-required");
        expect(settled.errors).toHaveLength(1);
        expect(settled.errors[0]!.cause).toBe("append-failed");
        expect(settled.errors[0]!.attempts).toBe(3);
        expect(settled.errors[0]!.entryCount).toBe(1);
        // The record carries a COUNT and a CAUSE. Never an entry: the batch that failed may have
        // carried opaque provider state, and a record is a thing that gets printed.
        expect(JSON.stringify(settled.errors[0])).not.toContain("hello");
      },
      { store: AlwaysFails, policy: { backoffMs: 1 } },
    );
  });

  test("a TIMED-OUT append is not retried — the one rule whose reason is duplication", async () => {
    let attempts = 0;
    class Hangs extends WinterCompatibilitySessionStore {
      override async append(): Promise<void> {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await withStoreBed(
      async (bed) => {
        await bed.shared.store.append(bed.key, [bed.entry()]);
        const settled = await bed.shared.settle(bed.key);
        expect(attempts).toBe(1);
        expect(settled.errors[0]!.cause).toBe("timed-out");
        expect(settled.errors[0]!.detail).toContain("may still land");
        expect(settled.transcriptHealth).toBe("repair-required");
      },
      { store: Hangs, policy: { attemptTimeoutMs: 20 } },
    );
  });

  test("`settle()` is the pending barrier, and a read settles its own session first", async () => {
    await withStoreBed(async (bed) => {
      const entry = bed.entry();
      await bed.shared.store.append(bed.key, [entry]);
      // Straight off the disk, the batch has not landed; through the facade, the read waits for it.
      const path = join(bed.home, "projects", bed.key.projectKey, `${bed.key.sessionId}.jsonl`);
      expect(() => readFileSync(path)).toThrow();
      const loaded = await bed.shared.store.load(bed.key);
      expect(loaded).toHaveLength(1);
      expect(readFileSync(path, "utf8")).toContain(entry["uuid"] as string);
    });
  });

  test("a subagent subkey settles with its parent session, never separately", async () => {
    await withStoreBed(async (bed) => {
      const subkey: SessionKey = { ...bed.key, subpath: "subagents/agent-a1" };
      await bed.shared.store.append(bed.key, [bed.entry()]);
      await bed.shared.store.append(subkey, [bed.entry({ key: subkey })]);
      const settled = await bed.shared.settle(bed.key);
      expect(settled.batchesCommitted).toBeGreaterThanOrEqual(1);
      expect(await bed.shared.canonical.listSubkeys({ projectKey: bed.key.projectKey, sessionId: bed.key.sessionId })).toContain("subagents/agent-a1");
    });
  });
});

describe("WS-14 §5's blind-import ban", () => {
  test("an import is refused while the mirror is unhealthy, and allowed once it is reconciled", async () => {
    class AlwaysFails extends WinterCompatibilitySessionStore {
      override async append(): Promise<void> {
        throw new Error("nope");
      }
    }
    await withStoreBed(
      async (bed) => {
        await bed.shared.store.append(bed.key, [bed.entry()]);
        await bed.shared.settle(bed.key);
        expect(() => bed.shared.assertImportAllowed(bed.key)).toThrow(BlindStoreImportError);
        await expect(guardedImportSessionToStore({ shared: bed.shared, key: bed.key, importer: async () => "imported" })).rejects.toThrow(BlindStoreImportError);
        try {
          bed.shared.assertImportAllowed(bed.key);
        } catch (error) {
          expect((error as Error).message).toContain("Reconcile the canonical tail");
        }
        bed.shared.markReconciled(bed.key, "test");
        await expect(guardedImportSessionToStore({ shared: bed.shared, key: bed.key, importer: async () => "imported" })).resolves.toBe("imported");
      },
      { store: AlwaysFails, policy: { backoffMs: 1 } },
    );
  });
});

describe("the decoration registry (WS-13 §8.2's no-wash-back mechanism)", () => {
  test("a copy-only entry never reaches the canonical store, and its child is re-parented onto the chain", async () => {
    await withStoreBed(async (bed) => {
      const [a] = await bed.append(1);
      const decoration = bed.entry();
      const turn = bed.entry();
      bed.shared.decorations.record(bed.key, { uuid: decoration["uuid"] as string, parentUuid: a!["uuid"] as string });

      await bed.shared.store.append(bed.key, [decoration, turn]);
      await bed.shared.settle(bed.key);
      const entries = (await bed.shared.store.load(bed.key)) ?? [];
      expect(entries.map((entry) => entry["uuid"])).toEqual([a!["uuid"], turn["uuid"]]);
      expect(entries[1]!["parentUuid"]).toBe(a!["uuid"] as string);
    });
  });

  test("a batch of nothing but decorations writes nothing at all", async () => {
    await withStoreBed(async (bed) => {
      await bed.append(1);
      const decoration = bed.entry();
      bed.shared.decorations.record(bed.key, { uuid: decoration["uuid"] as string, parentUuid: null });
      await bed.shared.store.append(bed.key, [decoration]);
      await bed.shared.settle(bed.key);
      expect(((await bed.shared.store.load(bed.key)) ?? []).length).toBe(1);
    });
  });

  test("`stripDecorations` returns the SAME objects when there is nothing to strip", () => {
    const registry = createDecorationRegistry();
    const key: SessionKey = { projectKey: "p", sessionId: "s" };
    const entries: SessionStoreEntry[] = [{ type: "user", uuid: "u1", parentUuid: null }];
    const result = stripDecorations(key, entries, registry);
    expect(result.dropped).toBe(0);
    expect(result.reparented).toBe(0);
    expect(result.entries[0]).toBe(entries[0]);
  });

  test("a chain of decorations re-parents onto the first canonical ancestor", () => {
    const registry = createDecorationRegistry();
    const key: SessionKey = { projectKey: "p", sessionId: "s" };
    registry.record(key, { uuid: "d1", parentUuid: "real" });
    registry.record(key, { uuid: "d2", parentUuid: "d1" });
    expect(registry.canonicalParentOf(key, "d2")).toBe("real");
    expect(registry.list(key)).toEqual(["d1", "d2"]);
    const result = stripDecorations(key, [{ type: "user", uuid: "u", parentUuid: "d2" }], registry);
    expect(result.entries[0]!["parentUuid"]).toBe("real");
    expect(result.reparented).toBe(1);
    registry.forget(key);
    expect(registry.has(key, "d1")).toBe(false);
  });
});

describe("the peer is the injection point", () => {
  test("`storePeers` really is the spine's own peer, widened", () => {
    const peers = storePeers();
    expect((peers.winter as unknown as { SDK_VERSION: string }).SDK_VERSION).toBe("0.0.2");
    expect((peers.winter as unknown as { WinterCompatibilitySessionStore: unknown }).WinterCompatibilitySessionStore).toBe(WinterCompatibilitySessionStore);
  });
});

describe("the mirror cannot be poisoned (review r1, F10/F12)", () => {
  test("a store that throws SYNCHRONOUSLY is recorded, not escaped — and the queue behind it survives", async () => {
    let calls = 0;
    class ThrowsSynchronously extends WinterCompatibilitySessionStore {
      // Deliberately NOT `async`: the pinned store's own append is, but an injected store is a seam,
      // and a synchronous throw used to escape the attempt loop entirely — leaving the FIFO tail
      // rejected, `settle()` hanging forever and every later batch skipped.
      override append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        calls += 1;
        if (calls <= 3) throw new Error("EIO on open");
        return super.append(key, entries);
      }
    }
    await withStoreBed(
      async (bed) => {
        await bed.shared.store.append(bed.key, [bed.entry()]);
        const first = await bed.shared.settle(bed.key);
        expect(first.settled).toBe(true);
        expect(first.transcriptHealth).toBe("repair-required");
        expect(first.errors[0]!.cause).toBe("append-failed");

        // The queue behind it still works: the mirror is degraded, never dead.
        bed.shared.markReconciled(bed.key, "test");
        const entry = bed.entry();
        await bed.shared.store.append(bed.key, [entry]);
        const second = await bed.shared.settle(bed.key);
        expect(second.settled).toBe(true);
        expect(((await bed.shared.store.load(bed.key)) ?? []).map((e) => e["uuid"])).toEqual([entry["uuid"]]);
      },
      { store: ThrowsSynchronously, policy: { backoffMs: 1 } },
    );
  });

  test("`settle()` reports what it OBSERVED: a batch opened while it was draining leaves it unsettled", async () => {
    await withStoreBed(async (bed) => {
      let reentered = false;
      let live: SharedSessionStore | undefined;
      class Reenters extends WinterCompatibilitySessionStore {
        override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
          await super.append(key, entries);
          if (!reentered) {
            reentered = true;
            // A turn that lands one more frame WHILE the barrier is draining — step 3's own question
            // is "has the canonical tail stopped moving", and the honest answer here is no.
            void live!.store.append(bed.key, [bed.entry()]);
          }
        }
      }
      const shared = createSharedSessionStore({ peers: storePeers({ store: Reenters }), winterHome: bed.home });
      live = shared;
      await shared.store.append(bed.key, [bed.entry()]);
      const report = await shared.settle(bed.key);
      expect(report.settled).toBe(false);
      // ...and a second settle, with nothing new arriving, is true.
      expect((await shared.settle(bed.key)).settled).toBe(true);
    });
  });
});

describe("`attach()` is the one door WS-05 §6 is enforced at (review r1, nit 2)", () => {
  test("options that already carry a DIFFERENT store are refused rather than silently overwritten", async () => {
    await withStoreBed(async (bed) => {
      const second = createSharedSessionStore({ peers: bed.peers, winterHome: bed.home });
      expect(() => bed.shared.attach({ sessionStore: second.store })).toThrow(SharedStoreOptionsError);
      // The same store is idempotent, not a conflict.
      expect(bed.shared.attach({ sessionStore: bed.shared.store }).sessionStore).toBe(bed.shared.store);
    });
  });
});
