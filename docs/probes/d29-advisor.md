# D29 probe — does the pinned official runtime expose an advisor server tool in an SDK session?

**Ruling:** R-7b-8 (Phase 7b plan; recorded as an execution amendment to WS-14, authority WS-06 D29).
**Obligation, verbatim (WS-14, "Execution amendments — advisor"):** *"whether the pinned official Agent
SDK 0.3.250 exposes Anthropic's advisor server tool inside an SDK session, and under which option or
account condition, is UNVERIFIED (the report has two mentions and neither answers it). The 7b
official-adapter task probes it against the pinned artifact through the loopback capture harness and
records the result before the D29 'each branch gets its own advisor' split is relied upon."*

**Probed:** 2026-09-08, Lane D, on `darwin-arm64` and again on `linux-x64` in CI (run `34286200040`,
`ubuntu-latest`), with identical observations on both — same runtime identity, same inventories, same
verdict.
**Reproduce:** `bun test test/selection/d29-advisor-probe.test.ts`. The test skips with a printed
reason when the pinned runtime cannot start (no platform binary for this host, a resolved version that
is not the pin, a launch that throws, or a run that never yields `system/init`).

---

## 1. What was driven, and how it was kept hermetic

| | |
| --- | --- |
| Wrapper | `@anthropic-ai/claude-agent-sdk`, resolved from this repository's `node_modules`; version asserted equal to `SUPPORTED.claudeAgentSdk` (`0.3.250`) before any condition runs |
| Runtime | the platform package's own binary, passed explicitly as `pathToClaudeCodeExecutable` (WS-14 §5.1 — never a binary on `PATH`) |
| Runtime identity observed on the wire | `claude-cli/2.1.250 (external, sdk-ts, agent-sdk/0.3.250)` — recorded from the endpoint request the fake received, in every condition |
| Endpoint | `@yanlinglabs/winter-provider-conformance`'s `anthropicFake` routes on a `127.0.0.1:0` loopback server, closed in a `finally` (`withLoopbackFake`) |
| Environment | `officialCaptureEnv` — a REPLACEMENT env of exactly `ANTHROPIC_BASE_URL` (the fake), `ANTHROPIC_API_KEY` (`sk-ant-fake-hermetic-key`), `CLAUDE_CONFIG_DIR` (fresh `mkdtemp`), `HOME` (a separate fresh `mkdtemp`); condition H adds one documented variable and says so |
| Settings | `settingSources: []` — no user, project or local settings file is read at any level |
| Working directory | a fresh `mkdtemp` per condition; the whole temp root is removed in a `finally` |
| Requests observed | every condition: `HEAD /api/hello` then `POST /v1/messages`, both to the loopback fake. No other path, and no real endpoint was configured for it to reach |
| Trace | the SDK's yielded messages, run through `@yanlinglabs/winter-conformance`'s `normalizeTrace` — the same normalizer the SDK repository's differential uses |

**Provenance of condition H's variable** (review r1, N5): `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`
was found in the **pinned artifact's own strings** while orienting (beside a disable twin), not in any
public documentation — this record has not checked it against published docs, and says "the
experimental enable variable" only in that sense. It is named here because the probe SET it, which is a
fact about the probe; nothing about the router depends on it.

**A methodological catch worth keeping.** During development this probe was first run from a scratch
directory, where the same import specifier resolved to a **different version** out of a global install
cache (`0.3.265`, `claude-cli/2.1.265`) rather than to the repository's pin. The test now asserts the
resolved package version against the version matrix before it measures anything. (The two versions
agreed on every observation below — but that is a fact this probe measured twice, not an assumption it
is entitled to.)

## 2. Conditions tried, and what each advertised

`init.tools` is the **client-side advertised inventory** — the list a host can allow, deny, alias or
rename. `wire tools` is what the runtime actually sent in the request's tool list to the endpoint.

| # | Condition | `init.tools` | advisor in `init.tools` | advisor on the wire |
| --- | --- | --- | --- | --- |
| A | default (model alias, `cwd`, `settingSources: []`) | 24 names | — none | — none |
| B | `tools: { type: "preset", preset: "claude_code" }` + `allowedTools: ["advisor", "Advisor"]` | 24 names | — none | — none |
| C | `tools: ["Read", "advisor"]` | 1 name (`Read`) | — none | — none |
| D | `systemPrompt: { type: "preset", preset: "claude_code" }` | 24 names | — none | — none |
| E | `settings: { advisorModel: <alias> }` | 24 names | — none | **`advisor_20260301` / `advisor`** |
| F | `settings: { advisorModel: <alias> }` **and `tools: []`** | 0 names | — none | **`advisor_20260301` / `advisor`** — the only tool on the wire |
| G | `extraArgs: { advisor: <alias> }` (the CLI flag) | 24 names | — none | **`advisor_20260301` / `advisor`** |
| H | the documented experimental enable variable, **no advisor model configured** | 24 names | — none | — none |
| I | as E, and the fake answers with a `server_tool_use` block named `advisor` | 24 names | — none | **`advisor_20260301` / `advisor`** |

The 24-name default inventory observed in A/B/D/E/G/H/I (a derived observation of the running
artifact, per WS-02 §2's "derived inventories", not a copied artifact):

```
Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree,
ListAgents, Monitor, NotebookEdit, PushNotification, Read, ReportFindings, ScheduleWakeup,
SendMessage, Skill, TaskOutput, TaskStop, WebFetch, WebSearch, Workflow, Write
```

The advisor entry, as the runtime sent it (the fake's captured request body, one entry of the tool
list): a versioned server-tool `type` — `advisor_20260301` — beside the bare name `advisor` and the
configured advisor model. It carries no input schema: nothing about it is client-implementable.

In condition I the block came back to the SDK consumer **verbatim**, as an assistant content block
`server_tool_use` named `advisor` — with no client-side tool ever having been advertised for it.

**One observation banked for Lane A** (review r1, N6), visible in every condition above and in the CI
log: the wire tool list names **`Agent`** where `init.tools` names **`Task`**. That is the runtime's own
client-name → wire-name mapping, and it is the only name in the set that differs between the two lists —
`SendMessage` and `ListAgents`, the two WS-14 §7 aliases, appear unchanged in both. Anything reasoning
about alias identity should compare against the list it actually means.

## 3. Verdict

**Exposed, but only under one condition, and never as a client tool.**

1. **Never in the session's advertised tool inventory.** Under every condition tried — including
   naming `advisor` in `tools` and in `allowedTools` — `system/init.tools` contains no advisor entry.
   The name is not a client tool in 0.3.250: naming it does nothing at all.
2. **On the wire exactly when the session configures an advisor model.** `settings.advisorModel` (and
   its CLI-flag twin, reached through `extraArgs`) is the switch. With no advisor model configured the
   runtime sends no advisor tool, and the documented experimental enable variable alone does not
   change that (condition H).
3. **Independent of the host's tool surface entirely.** With every builtin tool disabled (`tools: []`)
   the advisor schema is still sent, and is then the *only* tool on the request. No allow-list,
   deny-list or alias the host controls can add it, remove it, or intercept it.
4. **It is an API-side server tool.** It reaches the model as a versioned server-tool schema, and its
   invocation comes back as a `server_tool_use` block rather than a tool call the host is asked to
   execute.

## 4. Consequence for D29

* **The D29 split holds, and this probe is what makes it a measurement rather than an inference.**
  WS-06 D29 gives the Winter branch its own native `advisor` and leaves the official branch with
  Anthropic's API-side one; WS-14 §11's amendment says the Winter MCP server registered into the
  official branch "does NOT carry an advisor… `toolAliases` cannot intercept a server tool". Points 1,
  3 and 4 above are the direct evidence for exactly that: there is nothing on the official branch's
  client tool surface to alias, and nothing the router could put there that would take precedence.
* **The router aliases neither advisor, and nothing in `src/` names one.** The official branch's
  advisor is the endpoint's; the Winter branch's is the Winter SDK's. There is no cross-branch
  aliasing, no proxying, and no reconciliation of the two — by design, and now by evidence.
* **One correction owed to WS-06/WS-14's wording (close-out, spec amendments).** Both currently read
  "Both branches therefore advertise `advisor` with the same empty schema." On the official branch at
  0.3.250 that is true only in the sense that the *model* may be offered the server tool, and only
  when the session sets `advisorModel`; it is never *advertised* in the session's tool inventory, and
  with no advisor model configured it is not offered at all. The honest statement is: **the Winter
  branch advertises `advisor` as a tool; the official branch offers Anthropic's server-side advisor to
  the model when — and only when — the session configures an advisor model, and never through the tool
  inventory.** A host that wants an advisor on the official branch must set `advisorModel` (WS-06 D30's
  `settings.advisor.model` is Winter's own knob and does not reach it).
* **Two consequences a host should know, both observed here.** (a) `advisorModel` names a model, so it
  is an auth/cost decision on the session's own credential, not a free capability — WS-06 D30's
  `WINTER_CLAUDE_REVIEWER_AUTH_KINDS` reasoning applies to the official branch too. (b) A projector
  (Phase 8, WS-15 §4) will see `server_tool_use` blocks named `advisor` in assistant content on the
  official branch and must have a shape for them; they are not tool calls it will ever be asked to
  execute.

## 5. What this probe did NOT establish

* **No account condition was varied.** Every condition ran against a loopback fake with a fake API
  key. Whether an account tier, a subscription credential or an organization policy changes any of the
  above is untested here and untestable hermetically; the model-catalog gate the runtime carries for
  advisor ranking (it declines to use an advisor for a base model with no advisor rank) is an
  endpoint-side fact this fake cannot exercise.
* **Nothing about behaviour after the tool fires.** The fake never returns a real advisor result; the
  probe measured what is *sent* and what is *surfaced*, not what an advisor round-trip does.
* **Two platforms, not every platform.** `darwin-arm64` locally and `linux-x64` in CI, which agreed
  exactly. The test runs the same way anywhere the pinned platform binary installs, and skips with a
  printed reason where it does not.
