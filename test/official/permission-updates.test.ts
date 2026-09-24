// WS-21 §4.3 (F21): permission updates are SESSION-ONLY on both legs.
//
// A durable destination would have the runtime write a settings file itself — `localSettings` is the
// repository's own `<project dir>/settings.local.json` (F21 measured the pin appending a git exclude
// for it) — while under WS-21 the DAEMON writes every settings file. So the router rewrites every
// destination that is not `session` to `session`, and says so once.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { WINTER_BRAND, WinterCompatibilitySessionStore, type PermissionResult } from "@yanlinglabs/winter-agent-sdk";

import { buildRunHome, createRuntimeSdk, type RuntimeSdkPeers } from "../../src/index.ts";
import { createApprovalBridge, type DecisionSource } from "../../src/official/callbacks.ts";
import { resetSessionOnlyWarning, sessionOnlyPermissionUpdates } from "../../src/run-home/permission-updates.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { cleanupRunHomeBeds, inputFor, runHomeBed } from "../run-home/support.ts";

afterEach(() => {
  cleanupRunHomeBeds();
  resetSessionOnlyWarning();
});

const rule = (destination: string) => ({ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "make:*" }], behavior: "allow", destination });
const DESTINATIONS = ["userSettings", "projectSettings", "localSettings", "cliArg", "session"];

describe("sessionOnlyPermissionUpdates", () => {
  test("every destination but `session` becomes `session`; everything else about the update is kept", () => {
    const result = { behavior: "allow", updatedInput: { command: "make" }, updatedPermissions: DESTINATIONS.map(rule) } as unknown as PermissionResult;
    const out = sessionOnlyPermissionUpdates(result) as { updatedPermissions: Array<{ destination: string; rules: unknown }> };
    expect(out.updatedPermissions.map((update) => update.destination)).toEqual(["session", "session", "session", "session", "session"]);
    expect(out.updatedPermissions[0]!.rules).toEqual([{ toolName: "Bash", ruleContent: "make:*" }]);
  });

  test("a result with nothing to rewrite is returned by identity", () => {
    const deny = { behavior: "deny", message: "no" } as unknown as PermissionResult;
    const sessionOnly = { behavior: "allow", updatedInput: {}, updatedPermissions: [rule("session")] } as unknown as PermissionResult;
    expect(sessionOnlyPermissionUpdates(deny)).toBe(deny);
    expect(sessionOnlyPermissionUpdates(sessionOnly)).toBe(sessionOnly);
  });

  test("the rewrite is logged ONCE per process — names only", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = { behavior: "allow", updatedInput: {}, updatedPermissions: [rule("localSettings")] } as unknown as PermissionResult;
      sessionOnlyPermissionUpdates(result);
      sessionOnlyPermissionUpdates(result);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("localSettings");
      expect(String(warn.mock.calls[0]?.[0])).not.toContain("make:*");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the official leg's bridge", () => {
  test("a broker's durable `localSettings` update reaches the runtime as `session`", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const sources: DecisionSource[] = [];
      const bridge = createApprovalBridge({
        brand: WINTER_BRAND,
        mode: "default",
        broker: async (request) => ({ behavior: "allow", updatedInput: request.input, updatedPermissions: DESTINATIONS.map(rule) }) as never,
        onDecision: ({ source }) => void sources.push(source),
      });
      const result = (await bridge("Bash", { command: "make" }, { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" } as never)) as { updatedPermissions: Array<{ destination: string }> };
      expect(result.updatedPermissions.map((update) => update.destination)).toEqual(["session", "session", "session", "session", "session"]);
      expect(sources).toEqual(["broker-destination-rewritten"]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the Winter leg (with a run home)", () => {
  const peers = () => {
    const { peer, calls } = createFakeWinterPeer();
    return {
      calls,
      peer: {
        ...peer,
        WinterCompatibilitySessionStore,
        resolveWinterHome: () => {
          throw new Error("a hermetic test must never resolve the real Winter home");
        },
      } as unknown as RuntimeSdkPeers["winter"],
    };
  };

  test("the host's `canUseTool` is wrapped: a `localSettings` update comes back as `session`", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const bed = runHomeBed();
      const runHome = await buildRunHome(inputFor(bed));
      const { peer, calls } = peers();
      const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain: createFakeKeychain(), requireRunHome: true, handoff: { winterHome: bed.home } });
      const host = async () => ({ behavior: "allow", updatedInput: {}, updatedPermissions: [rule("localSettings")] }) as never;
      sdk.query({ prompt: "hi", options: { cwd: bed.cwd, canUseTool: host, runtime: { runHome } } });
      const forwarded = calls[0]!.options.canUseTool as (name: string, input: Record<string, unknown>, opts: unknown) => Promise<{ updatedPermissions: Array<{ destination: string }> }>;
      expect(forwarded).not.toBe(host);
      const answer = await forwarded("Bash", {}, {});
      expect(answer.updatedPermissions.map((update) => update.destination)).toEqual(["session"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("without a run home, the host's callback is forwarded untouched (existing callers are unchanged)", () => {
    const { peer, calls } = peers();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain: createFakeKeychain() });
    const host = async () => ({ behavior: "allow", updatedInput: {} }) as never;
    sdk.query({ prompt: "hi", options: { canUseTool: host } });
    expect(calls[0]!.options.canUseTool).toBe(host);
  });
});
