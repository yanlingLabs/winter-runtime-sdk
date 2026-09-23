// WS-21 CONTRACT A — the router's run-home surface, as the daemon (lane L3) consumes it.
//
// What is pinned here is the SHAPE a host builds against: the two path helpers, the constants, the
// attach points on both `query()` overloads and the `requireRunHome` refusal. The builder's behaviour
// has its own files (`build-core`, `items`, `instructions`, `settings`, `mcp`, `apply`, …).
import { describe, expect, test } from "bun:test";

import * as router from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";

const keychain = createFakeKeychain();

const claudeSelection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "anthropic",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "the contract test",
  decidedAt: new Date(0).toISOString(),
};

describe("WS-21 Contract A: helpers and constants", () => {
  test("sdkHomeOf joins `sdk` onto the daemon home", () => {
    expect(router.sdkHomeOf("/h")).toBe("/h/sdk");
    expect(router.sdkHomeOf("/h/")).toBe("/h/sdk");
  });

  test("fsRootAnchored is claude's absolute rule form: `/` followed by the absolute path", () => {
    expect(router.fsRootAnchored("/Users/x")).toBe("//Users/x");
    expect(router.fsRootAnchored("/Users/x/secrets")).toBe("//Users/x/secrets");
  });

  test("fsRootAnchored refuses a relative path — a rule anchored on nothing is not an absolute rule", () => {
    expect(() => router.fsRootAnchored("Users/x")).toThrow(TypeError);
    expect(() => router.fsRootAnchored("")).toThrow(TypeError);
  });

  test("the contract version and the persistent set are the ones L3 builds against", () => {
    expect(router.RUN_HOME_CONTRACT_VERSION).toBe(1);
    expect([...router.RUN_HOME_PERSISTENT_ENTRIES]).toEqual(["file-history", "tasks", "teams", "agent-memory", "workflows"]);
  });

  test("protectedPathRules: Edit and Write ask rules over the sdk home's item dirs, WINTER.md, and the trusted project's item dirs", () => {
    const rules = router.protectedPathRules("/h/sdk", "/repo");
    for (const tool of ["Edit", "Write"]) {
      for (const kind of ["skills", "commands", "rules", "output-styles"]) {
        expect(rules).toContain(`${tool}(//h/sdk/${kind}/**)`);
        expect(rules).toContain(`${tool}(//repo/.winter/${kind}/**)`);
      }
      expect(rules).toContain(`${tool}(//h/sdk/WINTER.md)`);
    }
    // No project, no project rules.
    expect(router.protectedPathRules("/h/sdk", null).some((rule) => rule.includes("//repo"))).toBe(false);
  });

  test("reconcileLocalWriteRoot is exported from the package root (the one reconcile, spec §3.8)", () => {
    expect(typeof router.reconcileLocalWriteRoot).toBe("function");
  });

  test("buildRunHome is exported from the package root", () => {
    expect(typeof router.buildRunHome).toBe("function");
  });
});

describe("WS-21 Contract A: `requireRunHome` — the router refuses a generation without a run home", () => {
  test("the Winter overload refuses `run_home_required` synchronously, before the peer is called", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = router.createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: true });
    let caught: unknown;
    try {
      sdk.query({ prompt: "hello", options: { cwd: "/tmp/nowhere" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(router.RunHomeError);
    expect((caught as router.RunHomeError).code).toBe("run_home_required");
    expect(calls).toHaveLength(0);
  });

  test("the official overload refuses `run_home_required` too, before any leg opens", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = router.createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: true });
    let caught: unknown;
    try {
      sdk.query({ prompt: "hello", options: { cwd: "/tmp/nowhere", runtime: { selection: claudeSelection, official: { sessionId: "s-1" } } } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(router.RunHomeError);
    expect((caught as router.RunHomeError).code).toBe("run_home_required");
    expect(calls).toHaveLength(0);
  });

  test("without `requireRunHome` an existing caller is unchanged (feature detection: the daemon opts in)", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = router.createRuntimeSdk({ peers: { winter: peer }, keychain });
    const options = { cwd: "/tmp/nowhere" };
    sdk.query({ prompt: "hello", options });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toBe(options);
  });

  test("the handle carries the two exit/recovery doors, and an unknown run id is `pending`", () => {
    const { peer } = createFakeWinterPeer();
    const sdk = router.createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: true });
    expect(typeof sdk.runHomeOutcome).toBe("function");
    expect(typeof sdk.reconcileRootForRecovery).toBe("function");
    expect(sdk.runHomeOutcome("never-seen")).toBe("pending");
  });

  test("`runHomeFor` is accepted at creation (the cold-resume callback)", () => {
    const { peer } = createFakeWinterPeer();
    const runHomeFor: router.RunHomeFor = async () => {
      throw new Error("not called in this test");
    };
    const sdk = router.createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: true, runHomeFor });
    expect(sdk.brand.projectDirName).toBe(".winter");
  });
});
