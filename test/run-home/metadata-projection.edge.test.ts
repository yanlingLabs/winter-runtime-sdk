// Edge cases of `mirroredMetadataFields`: the projection of a subagent's metadata on which two copies
// (the working copy's `.meta.json` and the store's `agent_metadata` entry) are compared.
import { describe, expect, test } from "bun:test";
import { mirroredMetadataFields } from "../../src/run-home/artifacts.ts";

const WHEN_DEFINED = ["isFork", "isBuiltIn", "spawnDepth", "planModeRequired", "isObserver", "observerStopped", "observerTaskId", "armingPermissionMode"];
const WHEN_TRUTHY = ["worktreePath", "worktreeBranch", "cwd", "spawnMode", "description", "name", "toolUseId", "parentAgentId", "taskKind", "teamName", "color", "customAgentType", "model", "permissionMode"];

describe("mirroredMetadataFields", () => {
  test("an empty object projects to the type alone", () => {
    expect(mirroredMetadataFields({})).toEqual({ type: "agent_metadata" });
  });

  test("the result's type is always agent_metadata, whatever the input's own type says", () => {
    expect(mirroredMetadataFields({ type: "something-else", agentType: "x" })).toEqual({ type: "agent_metadata", agentType: "x" });
  });

  test("agentType is carried whenever it is not undefined -- null, false and an empty string included", () => {
    for (const v of [null, false, "", 0, "Explore"]) expect(mirroredMetadataFields({ agentType: v })).toEqual({ type: "agent_metadata", agentType: v });
    expect(mirroredMetadataFields({ agentType: undefined })).toEqual({ type: "agent_metadata" });
  });

  test("the defined-only fields are carried for every value but undefined (false, 0, null, '' kept)", () => {
    for (const field of WHEN_DEFINED) {
      for (const v of [false, 0, null, "", true, 3, "x"]) expect(mirroredMetadataFields({ [field]: v })).toEqual({ type: "agent_metadata", [field]: v });
      expect(mirroredMetadataFields({ [field]: undefined })).toEqual({ type: "agent_metadata" });
    }
  });

  test("the truthy-only fields are carried only when truthy", () => {
    for (const field of WHEN_TRUTHY) {
      for (const v of [false, 0, null, "", undefined, Number.NaN]) expect(mirroredMetadataFields({ [field]: v })).toEqual({ type: "agent_metadata" });
      for (const v of ["x", 1, true, {}, []]) expect(mirroredMetadataFields({ [field]: v })).toEqual({ type: "agent_metadata", [field]: v });
    }
  });

  test("stoppedByUser is carried as literal true when truthy, and dropped otherwise", () => {
    expect(mirroredMetadataFields({ stoppedByUser: true })).toEqual({ type: "agent_metadata", stoppedByUser: true });
    expect(mirroredMetadataFields({ stoppedByUser: "yes" })).toEqual({ type: "agent_metadata", stoppedByUser: true });
    expect(mirroredMetadataFields({ stoppedByUser: 1 })).toEqual({ type: "agent_metadata", stoppedByUser: true });
    expect(mirroredMetadataFields({ stoppedByUser: false })).toEqual({ type: "agent_metadata" });
    expect(mirroredMetadataFields({ stoppedByUser: 0 })).toEqual({ type: "agent_metadata" });
  });

  test("any other field is dropped", () => {
    expect(mirroredMetadataFields({ agentType: "a", extra: 1, totalTokens: 9, startedAt: "t" })).toEqual({ type: "agent_metadata", agentType: "a" });
  });

  test("carried values are the input's own values (not copies)", () => {
    const obj = { deep: 1 };
    expect(mirroredMetadataFields({ cwd: obj })["cwd"]).toBe(obj);
  });
});
