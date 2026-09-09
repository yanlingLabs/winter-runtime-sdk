// WS-14 §13's taxonomy, held to its own promise: fourteen named failures, never a collapsed `Error`.
//
// The two assertions that matter here are not "the class exists". They are:
//
//   1. EVERY `winterClass` NAMES A REAL WS-03 §11 CLASS. The mapping is the taxonomy's whole purpose
//      (a host routing both branches into one projector needs to know which of ITS classes an
//      official-branch failure corresponds to), and a mapping onto a name that does not exist is a
//      mapping that fails silently, at the projector, months later. This test resolves each name
//      against the real Winter SDK module.
//   2. CRASH CLASSES ARE EXACTLY THE PROCESS-LIFECYCLE ONES. §9 requires them "distinct from
//      agent-result failures"; a `crashClass` that leaked onto `OfficialAgentResultError` would erase
//      that distinction in the one field a consumer branches on.
import { describe, expect, test } from "bun:test";
import * as winter from "@yanlinglabs/winter-agent-sdk";

import { RuntimeSdkError } from "../../src/errors.ts";
import {
  OFFICIAL_ERROR_CODES,
  OfficialAgentResultError,
  OfficialApiError,
  OfficialBranchError,
  OfficialConfigurationError,
  OfficialConnectionError,
  OfficialContainmentBreachError,
  OfficialExecutableNotFoundError,
  OfficialInterruptedError,
  OfficialInvalidResumeError,
  OfficialKilledError,
  OfficialMcpError,
  OfficialNonzeroExitError,
  OfficialPermissionDeniedError,
  OfficialProtocolError,
  OfficialSessionNotFoundError,
  OfficialSessionStoreError,
  OfficialStdoutUnterminatedError,
  OfficialToolError,
  isOfficialBranchError,
} from "../../src/official/errors.ts";
import { OFFICIAL_DISCLOSURES, officialBranchLabel } from "../../src/official/branding.ts";

const branchLabel = officialBranchLabel(winter.WINTER_BRAND);

const every = (): OfficialBranchError[] => [
  new OfficialConfigurationError({ option: "persistSession", reason: "r", branchLabel }),
  new OfficialExecutableNotFoundError({ path: "/nowhere/claude", branchLabel }),
  new OfficialConnectionError({ reason: "stdout closed", branchLabel }),
  new OfficialProtocolError({ reason: "not json", branchLabel }),
  new OfficialNonzeroExitError({ exitCode: 3, signal: null, stderrTail: "boom", branchLabel }),
  new OfficialKilledError({ signal: "SIGKILL", reason: "teardown", branchLabel }),
  new OfficialAgentResultError({ subtype: "error_during_execution", branchLabel }),
  new OfficialApiError({ reason: "overloaded", status: 529, branchLabel }),
  new OfficialToolError({ tool: "Read", reason: "enoent", branchLabel }),
  new OfficialPermissionDeniedError({ tool: "Write", reason: "the deny floor", branchLabel }),
  new OfficialMcpError({ server: "capabilities", reason: "no such server", branchLabel }),
  new OfficialSessionStoreError({ reason: "mirror failed", recordedLocalWriteRoot: "/tmp/x", branchLabel }),
  new OfficialSessionNotFoundError({ sessionId: "abc", reason: "ambiguous", branchLabel }),
  new OfficialInvalidResumeError({ reason: "fork of a fork", branchLabel }),
  new OfficialInterruptedError({ gesture: "interrupt-turn", branchLabel }),
  new OfficialStdoutUnterminatedError({ graceMs: 2000, branchLabel }),
  new OfficialContainmentBreachError({ toolName: "Bash", created: ["/w/.claude"], removed: ["/w/.claude"], retained: [], branchLabel }),
];

describe("WS-14 §13 — the official branch's error taxonomy", () => {
  test("every declared code has exactly one class, and every class is a RuntimeSdkError", () => {
    const codes = every().map((e) => e.code);
    expect([...codes].sort()).toEqual([...OFFICIAL_ERROR_CODES].sort());
    expect(new Set(codes).size).toBe(OFFICIAL_ERROR_CODES.length);
    for (const error of every()) {
      expect(error).toBeInstanceOf(RuntimeSdkError);
      expect(isOfficialBranchError(error)).toBe(true);
      expect(error.name).toBe(error.constructor.name);
      // WS-14 §14: a diagnostics line names the branch without the host having to add it.
      expect(error.branch).toBe("winter-claude-agent");
      expect(error.message.startsWith("winter-claude-agent: ")).toBe(true);
    }
    expect(isOfficialBranchError(new Error("x"))).toBe(false);
  });

  test("every `winterClass` names a real WS-03 §11 export of the injected Winter SDK", () => {
    const exported = new Set(Object.keys(winter));
    for (const error of every()) {
      expect([error.code, exported.has(error.winterClass)]).toEqual([error.code, true]);
      // and it really is a class, not a same-named value
      expect(typeof (winter as unknown as Record<string, unknown>)[error.winterClass]).toBe("function");
    }
  });

  test("crash classes are exactly the process-lifecycle failures (§9's distinction from agent-result)", () => {
    const withCrash = every()
      .filter((e) => e.crashClass !== undefined)
      .map((e) => [e.code, e.crashClass]);
    expect(withCrash).toEqual([
      ["official_executable_not_found", "executable-not-found"],
      ["official_connection_failure", "connection-failure"],
      ["official_malformed_protocol", "malformed-protocol"],
      ["official_nonzero_exit", "nonzero-exit"],
      ["official_killed", "killed"],
      // review r1, M4: the sixth class, beyond §9's five — an exit whose stdout never closed.
      ["official_stdout_unterminated", "stdout-unterminated"],
    ]);
    expect(new OfficialAgentResultError({ subtype: "error_max_turns", branchLabel }).crashClass).toBeUndefined();
  });

  test("`mirror_error` is non-fatal to the turn and carries the root reconciliation needs (§5)", () => {
    const error = new OfficialSessionStoreError({ reason: "3 attempts failed", recordedLocalWriteRoot: "/tmp/claude-resume-9", branchLabel });
    expect(error.fatalToTurn).toBe(false);
    expect(error.transcriptHealth).toBe("repair-required");
    expect(error.recordedLocalWriteRoot).toBe("/tmp/claude-resume-9");
  });

  test("the diagnostics label is BRAND-DERIVED, not a literal (WS-01 §5 / D19)", () => {
    expect(officialBranchLabel({ processLabel: "acme" })).toBe("acme-claude-agent");
    expect(officialBranchLabel(winter.WINTER_BRAND)).toBe("winter-claude-agent");
  });

  test("the §14 disclosure set names every vendor literal a user can meet, with its reason", () => {
    const ids = OFFICIAL_DISCLOSURES.map((d) => d.id);
    expect(ids).toEqual(["signed-binary-identity", "spool-config-file", "nested-engine-temp", "resume-staging", "vendor-telemetry-defaults", "extraction-cache"]);
    for (const disclosure of OFFICIAL_DISCLOSURES) {
      expect([disclosure.id, disclosure.literal.length > 0, disclosure.why.length > 25]).toEqual([disclosure.id, true, true]);
    }
    // The honest caveat D12 attaches to the process label is the FIRST row, and it is the signed id.
    expect(OFFICIAL_DISCLOSURES[0]?.literal).toBe("com.anthropic.claude-code");
  });
});
