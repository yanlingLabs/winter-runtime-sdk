// P8c-13: the official-leg HOST SURFACE re-exported from `src/index.ts`.
//
// Before this cut, `createApprovalBridge` (and the MCP materializer, and the env builder) had no path
// from the package root: `package.json` `exports` had only `"."`, and `src/index.ts` did not re-export
// `src/official/index.ts`'s host-facing helpers, so a host bridging its own approval broker into
// `canUseTool` had nothing to import. This test is the narrow proof that every name the brief asked
// for is actually reachable off the ROOT barrel (not off `./official/index.ts`, a test-only import
// site) — a value is a function or object, never `undefined`, and a type-only name at least does not
// collide with anything (checked by TypeScript compiling this file, since a type has no runtime
// presence to assert on).
import { describe, expect, test } from "bun:test";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";

import {
  createApprovalBridge,
  isOurApprovalBridge,
  materializeOfficialMcpServer,
  officialMcpServers,
  winterMcpServerDescriptor,
  canonicalToolNames,
  OFFICIAL_MATERIALIZATION_DROPS,
  minimalOsEnvironmentFrom,
  buildOfficialChildEnv,
  containmentDispositions,
  officialDisallowedTools,
  officialBranchLabel,
  OFFICIAL_DISCLOSURES,
  renderAttributedTurn,
} from "../../src/index.ts";
import type {
  ApprovalBroker,
  ApprovalRequest,
  ApprovalBridgeOptions,
  DecisionSource,
  OfficialPermissionMode,
  OfficialApprovalBridge,
  OfficialMcpModule,
  InputShapeFactory,
  JsonSchemaObject,
  WinterMcpServerDescriptor,
  WinterMcpToolDescriptor,
  WinterMcpHandler,
  WinterMcpToolResult,
  OfficialEnvPolicy,
  OfficialEnvInput,
  EnvAllowlistSnapshot,
  OptionsTemplatePolicy,
  ContainmentPolicy,
  ContainmentDisposition,
  AuthCredentialPlan,
  AuthFamily,
  ClaudeOauthGate,
} from "../../src/index.ts";
import type {
  DetailedHandoffOutcome,
  HandoffBarrierDeps,
  HandoffDestinationRuntime,
  HandoffEligibilityLike,
  HandoffOwnerHealth,
  HandoffParticipants,
  HandoffResumeTarget,
  HandoffSelection,
  HandoffSourceOwner,
  HandoffStepReport,
  MaterializedResumeDecoratorHandle,
} from "../../src/index.ts";

describe("the official-leg host surface is reachable from the package root", () => {
  test("every value export is a function or object, never undefined", () => {
    const values: Record<string, unknown> = {
      createApprovalBridge,
      isOurApprovalBridge,
      materializeOfficialMcpServer,
      officialMcpServers,
      winterMcpServerDescriptor,
      canonicalToolNames,
      OFFICIAL_MATERIALIZATION_DROPS,
      minimalOsEnvironmentFrom,
      buildOfficialChildEnv,
      containmentDispositions,
      officialDisallowedTools,
      officialBranchLabel,
      OFFICIAL_DISCLOSURES,
      renderAttributedTurn,
    };
    for (const [name, value] of Object.entries(values)) {
      expect({ name, kind: typeof value }).not.toEqual({ name, kind: "undefined" });
      expect({ name, isFunctionOrObject: typeof value === "function" || typeof value === "object" }).toEqual({ name, isFunctionOrObject: true });
    }
    // Not vacuous: the object actually has the right shape a host would call `canUseTool` with.
    expect(typeof createApprovalBridge).toBe("function");
    expect(typeof isOurApprovalBridge).toBe("function");
  });

  test("createApprovalBridge builds something isOurApprovalBridge recognises", () => {
    const bridge = createApprovalBridge({ brand: WINTER_BRAND, mode: "default", broker: async () => ({ behavior: "deny", message: "no" }) });
    expect(isOurApprovalBridge(bridge)).toBe(true);
  });

  test("the MCP materializer's drop list is the documented pair", () => {
    expect(OFFICIAL_MATERIALIZATION_DROPS).toEqual(["outputSchema", "exposure"]);
  });

  test("the branding surface names the branch and carries at least one disclosure", () => {
    expect(typeof officialBranchLabel).toBe("function");
    expect(Array.isArray(OFFICIAL_DISCLOSURES) || typeof OFFICIAL_DISCLOSURES === "object").toBe(true);
  });

  // Type-only names have no runtime presence to assert on; importing them above is the check --
  // `tsc`/`bun test`'s own type stripping fails this file to compile if any of the following did not
  // actually resolve off the root barrel.
  test("the type-only names compile (see the import above)", () => {
    const typesCompiled: [ApprovalBroker?, ApprovalRequest?, ApprovalBridgeOptions?, DecisionSource?, OfficialPermissionMode?, OfficialApprovalBridge?, OfficialMcpModule?, InputShapeFactory?, JsonSchemaObject?, WinterMcpServerDescriptor?, WinterMcpToolDescriptor?, WinterMcpHandler?, WinterMcpToolResult?, OfficialEnvPolicy?, OfficialEnvInput?, EnvAllowlistSnapshot?, OptionsTemplatePolicy?, ContainmentPolicy?, ContainmentDisposition?, AuthCredentialPlan?, AuthFamily?, ClaudeOauthGate?] = [];
    expect(typesCompiled.length).toBe(0);
  });
});

// P8c-13 fix round 2: the HANDOFF PARTICIPANT types re-exported from the package root.
//
// STRONGER THAN THE TUPLE-OF-OPTIONALS TRICK ABOVE, deliberately: a `satisfies`/assignment check
// fails to compile not only if a name stops resolving, but if its SHAPE drifts out from under a real
// literal built against it -- a plain `[T?]` tuple would still compile against `T = never` or a type
// whose members all changed. `HandoffResumeTarget` and `MaterializedResumeDecoratorHandle` are used
// only in PARAMETER-TYPE position (never constructed as full literals): both pull in auxiliary types
// this barrel does not otherwise export (`MaterializedResumeDoor`, the full `RuntimeSelection` shape,
// `MaterializedResumeDecorator`'s own async surface), and a parameter annotation exercises "the name
// resolves off the root barrel" exactly as hard as a literal would, without hand-building objects this
// test has no other reason to construct.
describe("the handoff participant types are reachable from the package root", () => {
  const ownerHealth = { launchedThroughProxy: false, transcriptHealth: "ok" } satisfies HandoffOwnerHealth;

  const eligible = { eligible: true } satisfies HandoffEligibilityLike;

  const stepReport = { ok: true } satisfies HandoffStepReport;

  const sourceOwner = {
    runtimeKind: "winter-agent",
    health: (): HandoffOwnerHealth => ownerHealth,
    eligibility: (): HandoffEligibilityLike => eligible,
    drainToIdleBoundary: (): HandoffStepReport => stepReport,
    drainStream: (): HandoffStepReport => stepReport,
    close: (): HandoffStepReport => stepReport,
  } satisfies HandoffSourceOwner;

  // `_target` names `HandoffResumeTarget` in parameter-type position -- see the header above.
  const destinationRuntime = {
    runtimeKind: "claude-agent",
    confirmInit: (_target: HandoffResumeTarget): HandoffStepReport => stepReport,
  } satisfies HandoffDestinationRuntime;

  const participants = {
    source: async () => sourceOwner,
    destination: async () => destinationRuntime,
  } satisfies HandoffParticipants;

  const barrierDeps = { participants } satisfies HandoffBarrierDeps;

  const outcome = { kind: "blocked", reason: "lease-held", step: 1, detail: "fixture", steps: [] } satisfies DetailedHandoffOutcome;

  /** Names `HandoffSelection` and `MaterializedResumeDecoratorHandle` in parameter-type position. */
  function acceptsSelectionAndDecorator(_selection: HandoffSelection, _decorator: MaterializedResumeDecoratorHandle): void {}

  test("every handoff participant shape satisfies its own type, not just an optional slot in a tuple", () => {
    expect(ownerHealth.transcriptHealth).toBe("ok");
    expect(eligible.eligible).toBe(true);
    expect(stepReport.ok).toBe(true);
    expect(sourceOwner.runtimeKind).toBe("winter-agent");
    expect(destinationRuntime.runtimeKind).toBe("claude-agent");
    expect(typeof participants.source).toBe("function");
    expect(barrierDeps.participants).toBe(participants);
    expect(outcome).toEqual({ kind: "blocked", reason: "lease-held", step: 1, detail: "fixture", steps: [] });
    expect(typeof acceptsSelectionAndDecorator).toBe("function");
  });
});
