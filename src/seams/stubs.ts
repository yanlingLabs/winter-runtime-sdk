// THE STUBS — one factory per seam, each method throwing `NotImplementedYet(lane)`.
//
// WHY FACTORIES AND NOT INLINE OBJECTS IN `sdk.ts`. Four lanes land behind these seams in parallel,
// and `src/sdk.ts` is spine-owned: every lane that has to touch it costs a NEEDS_CONTEXT round trip.
// With one factory call per seam, a lane's wiring diff is a SINGLE LINE at a named call site
// (`stubGlobalMessaging()` -> `createGlobalMessaging(...)`), which is the smallest edit that can
// possibly exist and the easiest to review.
//
// WHY THEY THROW rather than returning something plausible: a stub that answered would let a lane —
// or a host — build on a value nobody computed, and the failure would surface far from here. The
// throw names the lane and the seam, so `bun test` output attributes an unimplemented path
// immediately, and `test/spine/seams.test.ts` asserts every stub is still honest.
import { NotImplementedYet } from "../errors.ts";
import type { SeamContext, SeamContextWithDirectory } from "./context.ts";
import type { RuntimeDirectory } from "./directory.ts";
import type { GlobalMessaging } from "./global-messaging.ts";
import type { HandoffBarrier } from "./handoff.ts";
import type { MaterializedResumeDecorator } from "./materialized-resume.ts";
import type { OfficialAdapter, OfficialSpawnClaudeCodeProcess } from "./official-adapter.ts";

/**
 * WS-14 §1–§13 — Lane A.
 *
 * Takes the full context because its real factory needs three things from it that nothing else in the
 * spine reaches: the injected `peers.claude` (to construct a query at all), the `KeychainSeam` (WS-14
 * §12's "fetched at spawn" — `EnvInput.credentials` arrives already built, so the fetch is Lane A's),
 * and the resolved `brand`.
 */
export function stubOfficialAdapter(context: SeamContextWithDirectory): OfficialAdapter {
  void context;
  const spawnProxy: OfficialSpawnClaudeCodeProcess = () => {
    throw new NotImplementedYet("lane-a", "the supervised spawn proxy (WS-14 §6)");
  };
  return {
    launch() {
      throw new NotImplementedYet("lane-a", "OfficialAdapter.launch (WS-14 §1)");
    },
    resume() {
      throw new NotImplementedYet("lane-a", "OfficialAdapter.resume (WS-14 §1/§5)");
    },
    buildOptions() {
      throw new NotImplementedYet("lane-a", "OfficialAdapter.buildOptions (WS-14 §2)");
    },
    buildChildEnv() {
      throw new NotImplementedYet("lane-a", "OfficialAdapter.buildChildEnv (WS-14 §3)");
    },
    spawnProxy,
  };
}

/**
 * WS-15 §6.1 — Lane B.
 *
 * Built FIRST, from the context without a directory in it, because everything else takes the
 * directory. That ordering is why `createRuntimeSdk` hoists it out of the handle's object literal.
 */
export function stubRuntimeDirectory(context: SeamContext): RuntimeDirectory {
  void context;
  return {
    async list() {
      throw new NotImplementedYet("lane-b", "RuntimeDirectory.list (WS-15 §6.1)");
    },
    async get() {
      throw new NotImplementedYet("lane-b", "RuntimeDirectory.get (WS-15 §6.1)");
    },
    async record() {
      throw new NotImplementedYet("lane-b", "RuntimeDirectory.record (WS-15 §6.1)");
    },
    async forget() {
      throw new NotImplementedYet("lane-b", "RuntimeDirectory.forget (WS-15 §6.1)");
    },
    async resolve() {
      throw new NotImplementedYet("lane-b", "RuntimeDirectory.resolve (WS-10 §11's resolution order)");
    },
    async recover() {
      throw new NotImplementedYet("lane-b", "RuntimeDirectory.recover (WS-15 §6.4's restart recovery)");
    },
  };
}

/** WS-15 §6.2–6.4 — Lane B. Needs the directory (resolution) and the store's new durable sinks (I1). */
export function stubGlobalMessaging(context: SeamContextWithDirectory): GlobalMessaging {
  void context;
  return {
    async listReachable() {
      throw new NotImplementedYet("lane-b", "GlobalMessaging.listReachable (WS-10 §10.2)");
    },
    async send() {
      throw new NotImplementedYet("lane-b", "GlobalMessaging.send (WS-10 §10.1/§11/§13)");
    },
    async deliver() {
      throw new NotImplementedYet("lane-b", "GlobalMessaging.deliver (WS-15 §6.2)");
    },
    async notifyWhenIdle() {
      throw new NotImplementedYet("lane-b", "GlobalMessaging.notifyWhenIdle (WS-10 §14)");
    },
    async senderPermissionClass() {
      throw new NotImplementedYet("lane-b", "GlobalMessaging.senderPermissionClass (WS-10 §13)");
    },
    registerAdapter() {
      throw new NotImplementedYet("lane-b", "GlobalMessaging.registerAdapter (WS-10 §15)");
    },
  };
}

/** WS-05 §12 — Lane C. Needs the directory and the store to compute `HandoffPlan.from`. */
export function stubHandoffBarrier(context: SeamContextWithDirectory): HandoffBarrier {
  void context;
  return {
    async plan() {
      throw new NotImplementedYet("lane-c", "HandoffBarrier.plan (WS-05 §12)");
    },
    async execute() {
      throw new NotImplementedYet("lane-c", "HandoffBarrier.execute (WS-05 §12's eight steps)");
    },
  };
}

/**
 * WS-13 §8.2 — Lane C.
 *
 * `door` is `"fallback"` and not a throw, deliberately: WS-13 §8.2 makes FALLBACK the always-available
 * door and PREFERRED the one that four probes must open. "Which door is open" therefore has a correct
 * answer before the lane lands, and it is this one — reporting `"preferred"` would be the lie.
 */
export function stubMaterializedResumeDecorator(context: SeamContextWithDirectory): MaterializedResumeDecorator {
  void context;
  return {
    door: "fallback",
    async probe() {
      throw new NotImplementedYet("lane-c", "MaterializedResumeDecorator.probe (WS-17 §8's four probes)");
    },
    async decorate() {
      throw new NotImplementedYet("lane-c", "MaterializedResumeDecorator.decorate (WS-13 §8.2)");
    },
  };
}
