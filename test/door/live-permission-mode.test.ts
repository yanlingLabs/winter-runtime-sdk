// 0.0.10 — A LIVE SESSION'S PERMISSION MODE, THROUGH THE DOOR'S OWN HANDLE.
//
// THE BUG THIS CLOSES. `Options.permissionMode` is fixed for a generation, and the door's handle named
// exactly two of the pin's members — so a host holding an official session had NO way to change its
// mode. A Code session switched from `accept-edits` to `ask` went on auto-approving every edit inside
// the child, with no card and no trace, until the session's next incarnation. The pinned runtime has
// carried `Query.setPermissionMode` all along ("only available in streaming input mode"), and the
// Winter leg has always used it; this is parity.
//
// WHAT IS MEASURED HERE, and it is not only "the call is forwarded":
//
//   1. the door's bridge follows the switch. `createApprovalBridge` short-circuits `dontAsk` to ALLOW
//      without consulting the host's broker, and it used to capture the mode once, at spawn. So a
//      `dontAsk` session switched live to `default` would start receiving `canUseTool` requests from
//      the child and this branch's own bridge would auto-approve every one of them — the same hole one
//      layer in. The bridge now reads the mode per decision.
//   2. the refusal is the LAUNCH path's, and it runs BEFORE the lazy spawn. The handle's `get` trap
//      forwards any member it does not name, so an unnamed `setPermissionMode` would have made the
//      launch path's `bypassPermissions` refusal bypassable by one method call.
//   3. the mode is adopted only when the CHILD accepted it.
//
// The official module is a FAKE, deliberately: what is under test is the door's composition, and the
// real-binary half (does a mid-turn control request actually change the runtime's behaviour) is proven
// where a real turn can be scripted — the host's own gated end-to-end bed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WinterCompatibilitySessionStore, type PermissionResult } from "@yanlinglabs/winter-agent-sdk";

import { createRuntimeSdk, RuntimeLaunchInputError } from "../../src/index.ts";
import { OfficialConfigurationError } from "../../src/official/errors.ts";
import { PINNED_OFFICIAL_RUNTIME } from "../../src/official/env-allowlist.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import type { OfficialOptions, OfficialPermissionMode, OfficialSdkModule } from "../../src/seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";

const keychain = createFakeKeychain();

/** `local-none` injects no credential, so nothing but the test's own gestures decides what happens. */
const OFFICIAL_SELECTION: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "loopback/claude-sonnet-4-5",
  family: "claude",
  authFamily: "local-none",
  sdkVersion: "0.0.2",
  reason: "live-mode fixture",
  decidedAt: new Date(0).toISOString(),
};

interface Bed {
  handle: {
    setPermissionMode(mode: OfficialPermissionMode): Promise<void>;
    close(): void;
  } & AsyncIterable<unknown>;
  /** Whether the lazy launch has happened — `claude.query()` called. */
  started: () => boolean;
  /** The modes the CHILD was actually told, in order. */
  modes: () => string[];
  /** The bridge the door installed on this session's options (`canUseTool`), once there is one. */
  bridge: () => (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>;
  /** Tool names the HOST's broker was consulted about. */
  brokered: () => string[];
  cleanup: () => void;
}

function bed(options: { permissionMode?: OfficialPermissionMode; refuseMode?: boolean } = {}): Bed {
  const root = mkdtempSync(join(tmpdir(), "w-livemode-"));
  const { peer } = createFakeWinterPeer();
  const modes: string[] = [];
  const brokered: string[] = [];
  let launched = false;
  let built: OfficialOptions | undefined;
  const claude = {
    query: (params: { options?: OfficialOptions }) => {
      launched = true;
      built = params.options;
      return {
        async *[Symbol.asyncIterator]() {
          /* no messages: this fake never runs a turn */
        },
        interrupt: async () => undefined,
        setPermissionMode: async (mode: string) => {
          if (options.refuseMode === true) throw new Error("the runtime refused the control request");
          modes.push(mode);
        },
      };
    },
    SDK_VERSION: PINNED_OFFICIAL_RUNTIME,
  } as unknown as OfficialSdkModule;
  const sdk = createRuntimeSdk({
    peers: { winter: { ...(peer as object), WinterCompatibilitySessionStore } as unknown as Parameters<typeof createRuntimeSdk>[0]["peers"]["winter"], claude },
    keychain,
    vendoredOfficialRuntime: "/vendored/claude",
    handoff: { winterHome: join(root, "home") },
  });
  const handle = sdk.query({
    prompt: "hi",
    options: {
      cwd: join(root, "w"),
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      // THE HOST'S OWN BROKER, so the door builds its bridge over it — the thing the mode decides.
      canUseTool: async (toolName: string) => {
        brokered.push(toolName);
        return { behavior: "allow", updatedInput: {} } as PermissionResult;
      },
      runtime: { selection: OFFICIAL_SELECTION, official: { sessionId: "live-mode", base: { HOME: join(root, "home"), PATH: "/usr/bin" } } },
    } as never,
  });
  return {
    handle: handle as unknown as Bed["handle"],
    started: () => launched,
    modes: () => [...modes],
    bridge: () => {
      const bridge = built?.canUseTool as ((toolName: string, input: Record<string, unknown>, rest: unknown) => Promise<PermissionResult>) | undefined;
      if (bridge === undefined) throw new Error("the launch did not install a bridge");
      return (toolName, input) => bridge(toolName, input, { signal: new AbortController().signal, requestId: "r1", toolUseID: "t1" });
    },
    brokered: () => [...brokered],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Starts the lazy launch the way a host does — one pull, which is all this fake has to give. */
async function launch(b: Bed): Promise<void> {
  for await (const _ of b.handle) void _;
  expect(b.started()).toBe(true);
}

describe("the door's handle changes a live session's permission mode", () => {
  test("the mode reaches the child, in order", async () => {
    const b = bed();
    try {
      await launch(b);
      await b.handle.setPermissionMode("plan");
      await b.handle.setPermissionMode("acceptEdits");
      await b.handle.setPermissionMode("default");
      expect(b.modes()).toEqual(["plan", "acceptEdits", "default"]);
    } finally {
      b.cleanup();
    }
  });

  test("the door's own bridge follows the switch — a `dontAsk` session that becomes `default` asks again", async () => {
    const b = bed({ permissionMode: "dontAsk" });
    try {
      await launch(b);
      // SPAWNED `dontAsk`: §10 says the callback is never invoked, so the broker must not be consulted.
      expect((await b.bridge()("Read", { file_path: "/work/repo/README.md" })).behavior).toBe("allow");
      expect(b.brokered()).toEqual([]);
      // ...and after the live switch the SAME bridge consults the host. Before 0.0.10 the bridge held
      // the spawn-time literal, so this call was auto-allowed with the broker never seeing it.
      await b.handle.setPermissionMode("default");
      expect((await b.bridge()("Read", { file_path: "/work/repo/README.md" })).behavior).toBe("allow");
      expect(b.brokered()).toEqual(["Read"]);
    } finally {
      b.cleanup();
    }
  });

  test("`bypassPermissions` is refused typed, and the child is never told", async () => {
    const b = bed();
    try {
      await launch(b);
      const error = await b.handle.setPermissionMode("bypassPermissions").then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(OfficialConfigurationError);
      expect((error as OfficialConfigurationError).option).toBe("permissionMode");
      expect((error as Error).message).toMatch(/shadows `canUseTool`/);
      expect(b.modes()).toEqual([]);
    } finally {
      b.cleanup();
    }
  });

  test("...and a refused mode does not spawn a child in order to fail", async () => {
    const b = bed();
    try {
      await expect(b.handle.setPermissionMode("bypassPermissions")).rejects.toBeInstanceOf(OfficialConfigurationError);
      // THE REFUSAL RUNS BEFORE `ready()`: an input refusal a host pays a child process for is not one.
      expect(b.started()).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  test("an UNSTARTED handle launches and then sets the mode — never a silent no-op", async () => {
    const b = bed();
    try {
      // The same edge `interrupt()` has, and the same answer: `Options.permissionMode` is already
      // fixed by the time the child comes up, so answering "fine" would be the lie this change removes.
      await b.handle.setPermissionMode("plan");
      expect(b.started()).toBe(true);
      expect(b.modes()).toEqual(["plan"]);
    } finally {
      b.cleanup();
    }
  });

  test("a CLOSED handle refuses exactly as `interrupt()` does", async () => {
    const b = bed();
    try {
      b.handle.close();
      await expect(b.handle.setPermissionMode("plan")).rejects.toBeInstanceOf(RuntimeLaunchInputError);
      expect(b.started()).toBe(false);
    } finally {
      b.cleanup();
    }
  });

  test("a child that refuses the control request rejects, and the bridge keeps the mode the child is in", async () => {
    const b = bed({ permissionMode: "dontAsk", refuseMode: true });
    try {
      await launch(b);
      await expect(b.handle.setPermissionMode("default")).rejects.toThrow(/refused the control request/);
      // NOT ADOPTED. The bridge still describes `dontAsk`, because that is still what the child is in —
      // a bridge that moved on a failed switch would ask for approvals the runtime is not requesting.
      expect((await b.bridge()("Read", { file_path: "/work/repo/README.md" })).behavior).toBe("allow");
      expect(b.brokered()).toEqual([]);
    } finally {
      b.cleanup();
    }
  });
});
