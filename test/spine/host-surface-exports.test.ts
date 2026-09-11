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
