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
import type { RuntimeDirectory } from "./directory.ts";
import type { RuntimeDirectoryStore } from "./directory-store.ts";
import type { GlobalMessaging } from "./global-messaging.ts";
import type { HandoffBarrier } from "./handoff.ts";
import type { MaterializedResumeDecorator } from "./materialized-resume.ts";
import type { OfficialAdapter, OfficialSpawnClaudeCodeProcess } from "./official-adapter.ts";

/** WS-14 §1–§13 — Lane A. */
export function stubOfficialAdapter(): OfficialAdapter {
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
 * Takes the resolved store even though it cannot use it yet, so the wiring line in `sdk.ts` already
 * passes what the real implementation needs and the lane's diff stays one line.
 */
export function stubRuntimeDirectory(store: RuntimeDirectoryStore): RuntimeDirectory {
  void store;
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

/** WS-15 §6.2–6.4 — Lane B. */
export function stubGlobalMessaging(): GlobalMessaging {
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

/** WS-05 §12 — Lane C. */
export function stubHandoffBarrier(): HandoffBarrier {
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
export function stubMaterializedResumeDecorator(): MaterializedResumeDecorator {
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
