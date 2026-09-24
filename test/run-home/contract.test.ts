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

  test("escapeSandboxGlobPath is exported from the package root: a path spelled for claude's SANDBOX glob grammar (`[` → `[[]`; everything else as written)", () => {
    // For the host's own absolute sandbox paths on the official leg (its denyWrite fence, <cwd>/.winter/agents, …).
    expect(router.escapeSandboxGlobPath("/x/[wip] app/.winter/agents")).toBe("/x/[[]wip] app/.winter/agents");
    expect(router.escapeSandboxGlobPath("/x/a]b (c) d\\e")).toBe("/x/a]b (c) d\\e");
    expect(router.escapeSandboxGlobPath("/x/plain")).toBe("/x/plain");
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

  test("protectedPathRules: Edit and Write ask rules over the sdk home's item dirs, WINTER.md, and the trusted project's item dirs AT ANY DEPTH under the root (C1)", () => {
    const rules = router.protectedPathRules("/h/sdk", "/repo");
    for (const tool of ["Edit", "Write"]) {
      for (const kind of ["skills", "commands", "rules", "output-styles"]) {
        expect(rules).toContain(`${tool}(//h/sdk/${kind}/**)`);
        // `**` matches zero or more directories (measured on the pin): the root's own `.winter/` and every
        // nested one — `packages/app/.winter/skills/**` included — are one rule.
        expect(rules).toContain(`${tool}(//repo/**/.winter/${kind}/**)`);
      }
      expect(rules).toContain(`${tool}(//h/sdk/WINTER.md)`);
    }
    expect(rules).toHaveLength(2 * (4 + 1 + 4));
    // No project, no project rules.
    expect(router.protectedPathRules("/h/sdk", null).some((rule) => rule.includes("//repo"))).toBe(false);
  });

  test("protectedPathRules: glob metacharacters in a path are escaped the way the pinned matcher reads them (minors round, item 2; the rule-content layer since the escape-table round)", () => {
    // TWO LAYERS, both measured on claude 2.1.250 and on the Winter runtime at ws21/sdk@6170adb: the
    // gitignore layer (`[`/`]` open a class unless backslash-escaped, `*` matches itself exactly only
    // when escaped, `?` must stay RAW, `(`/`)` are escaped too), then claude's own rule-content escape
    // `c()` (every backslash doubled, `(`/`)` escaped), because the rule string is unescaped once before
    // the gitignore layer sees it. `{}`, `!`, `#` and spaces are literal as written.
    const rules = router.protectedPathRules("/h/[s]dk", "/x/[wip] a*b?c{d}!(e)#f");
    expect(rules).toContain(String.raw`Write(//x/\\[wip\\] a\\*b?c{d}!\\\(e\\\)#f/**/.winter/skills/**)`);
    expect(rules).toContain(String.raw`Edit(//h/\\[s\\]dk/skills/**)`);
    expect(rules).toContain(String.raw`Edit(//h/\\[s\\]dk/WINTER.md)`);
    // A literal backslash is FOUR in the rule string (claude matches nothing less — measured).
    expect(router.protectedPathRules("/h/sdk", String.raw`/x/a\b`)).toContain(String.raw`Write(//x/a\\\\b/**/.winter/skills/**)`);
    // The helper itself, exported for a host that spells rules over the same paths.
    expect(router.escapeRulePath(String.raw`/x/[a]*b?\c`)).toBe(String.raw`/x/\\[a\\]\\*b?\\\\c`);
    expect(router.escapeRulePath(String.raw`/p (old)/q\(y`)).toBe(String.raw`/p \\\(old\\\)/q\\\\\\\(y`);
    // Trailing whitespace is escaped char by char, as claude's own path escaper does (gitignore drops an
    // unescaped trailing space), so the helper is safe for a path that ENDS the rule.
    expect(router.escapeRulePath("/x/sp ")).toBe(String.raw`/x/sp\\ `);
    expect(router.escapeRulePath("/x/tab\t \t")).toBe(`/x/tab${String.raw`\\`}\t${String.raw`\\`} ${String.raw`\\`}\t`);
    expect(router.escapeRulePath("/x/in side/y")).toBe("/x/in side/y");
  });

  test("escapeRulePath is claude's rule-content escape over the gitignore-layer escape: the read side's one unescape gives back the gitignore pattern, and the rule's own parens stay findable", () => {
    // The read side, as claude 2.1.250 does it (L1a's port, ws21/sdk@6170adb): the tool name ends at the
    // first UNESCAPED `(` and the content at the last unescaped `)` (an even run of backslashes before
    // it), then the content is unescaped once: `\(`→`(`, `\)`→`)`, `\\`→`\`, in that order.
    const unescaped = (index: number, text: string): boolean => {
      let run = 0;
      for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) run += 1;
      return run % 2 === 0;
    };
    const parse = (rule: string): { tool: string; content: string } => {
      let open = -1;
      for (let i = 0; i < rule.length && open === -1; i += 1) if (rule[i] === "(" && unescaped(i, rule)) open = i;
      let close = -1;
      for (let i = rule.length - 1; i >= 0 && close === -1; i -= 1) if (rule[i] === ")" && unescaped(i, rule)) close = i;
      expect(close).toBe(rule.length - 1);
      const content = rule.slice(open + 1, close).replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll("\\\\", "\\");
      return { tool: rule.slice(0, open), content };
    };
    const gitignore = (path: string): string => path.replace(/[[\]*\\()]/g, "\\$&");
    const escapeRulePathFor = (path: string): string => router.escapeRulePath(path);
    for (const path of ["/x/[wip] app", String.raw`/x/a\b`, "/x/Project (old)", "/x/p (x", "/x/p x)", String.raw`/x/q\(y`, String.raw`/x/q\)`, String.raw`/x/q8\[w] *z`, String.raw`/x/end\\`]) {
      expect([path, parse(`Edit(${escapeRulePathFor(path)}/**)`)]).toEqual([path, { tool: "Edit", content: `${gitignore(path)}/**` }]);
      // And as the LAST part of the rule, where a trailing backslash or space matters most.
      expect([path, parse(`Edit(${escapeRulePathFor(path)})`)]).toEqual([path, { tool: "Edit", content: gitignore(path) }]);
    }
    for (const path of ["/x/sp ", "/x/sp  \t"]) {
      const trailing = path.length - path.trimEnd().length;
      const expected = `${gitignore(path.trimEnd())}${[...path.slice(path.length - trailing)].map((character) => `\\${character}`).join("")}`;
      expect([path, parse(`Edit(${escapeRulePathFor(path)})`)]).toEqual([path, { tool: "Edit", content: expected }]);
    }
  });

  test("protectedPathRules: the walk adds nothing any more — every walk dir is under the root, which the any-depth rule already covers (C1)", () => {
    const withWalk = router.protectedPathRules("/h/sdk", "/repo", undefined, { cwd: "/repo/a/b", userHome: "/home/u" });
    expect(withWalk).toEqual(router.protectedPathRules("/h/sdk", "/repo"));
    // A write the old walk-only rules missed: the root's cwd writing a DEEPER directory's items.
    expect(withWalk).toContain("Write(//repo/**/.winter/skills/**)");
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
    const sdk = router.createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: true, handoff: { winterHome: "/tmp/ws21-contract-home" } });
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
    const sdk = router.createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: true, handoff: { winterHome: "/tmp/ws21-contract-home" } });
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
    const sdk = router.createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: true, handoff: { winterHome: "/tmp/ws21-contract-home" } });
    expect(typeof sdk.runHomeOutcome).toBe("function");
    expect(typeof sdk.reconcileRootForRecovery).toBe("function");
    expect(sdk.runHomeOutcome("never-seen")).toBe("pending");
  });

  test("a run-home router must name its home — its store is rooted at the shared runtime home under it", () => {
    const { peer } = createFakeWinterPeer();
    expect(() => router.createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: true })).toThrow(/handoff\.winterHome/);
  });

  test("`runHomeFor` is accepted at creation (the cold-resume callback)", () => {
    const { peer } = createFakeWinterPeer();
    const runHomeFor: router.RunHomeFor = async () => {
      throw new Error("not called in this test");
    };
    const sdk = router.createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: true, runHomeFor, handoff: { winterHome: "/tmp/ws21-contract-home" } });
    expect(sdk.brand.projectDirName).toBe(".winter");
  });
});
