# D29 probe — does the pinned official runtime expose an advisor server tool in an SDK session?

**Ruling:** R-7b-8 (Phase 7b plan; recorded as an execution amendment to WS-14, authority WS-06 D29).
**Obligation, verbatim (WS-14, "Execution amendments — advisor"):** *"whether the pinned official Agent
SDK 0.3.250 exposes Anthropic's advisor server tool inside an SDK session, and under which option or
account condition, is UNVERIFIED (the report has two mentions and neither answers it). The 7b
official-adapter task probes it against the pinned artifact through the loopback capture harness and
records the result before the D29 'each branch gets its own advisor' split is relied upon."*

**Probed:** 2026-09-08, Lane D. **REWRITTEN 2026-09-09 (P7b fix wave, whole-branch finding F-1): the
first version's verdict was wrong, and wrong in a way worth recording.** It ran the pinned runtime
with the model endpoint pointed at a loopback fake and called that hermetic; the child was still free
to fetch its own REMOTE FEATURE CONFIGURATION, and the advisor server tool turned out to be gated by
that fetch rather than by anything the session configured. The original §3 point 2 — "on the wire
exactly when the session configures an advisor model" — was a statement about what a CDN answered
that minute. It also made the suite red whenever the fetch timed out inside the 60 s window, which is
the identity of the "suite-level flake seen twice in ~20 runs" the Lane B report could not reproduce.

**Reproduce:** `bun test test/selection/d29-advisor-probe.test.ts` — the HERMETIC legs, which are the
ruling's evidence. `WINTER_D29_ALLOW_REMOTE_CONFIG=1 bun test test/selection/d29-advisor-probe.test.ts`
adds the one non-hermetic leg that re-derives the remote-configuration observation; it reaches a live
CDN, so its result is somebody else's deployment state and nothing rests on it. The test skips with a
printed reason when the pinned runtime cannot start (no platform binary for this host, a resolved
version that is not the pin, a launch that throws, or a run that never yields `system/init`).

---

## 1. What was driven, and how it was kept hermetic

| | |
| --- | --- |
| Wrapper | `@anthropic-ai/claude-agent-sdk`, resolved from this repository's `node_modules`; version asserted equal to `SUPPORTED.claudeAgentSdk` (`0.3.250`) before any condition runs |
| Runtime | the platform package's own binary, passed explicitly as `pathToClaudeCodeExecutable` (WS-14 §5.1 — never a binary on `PATH`) |
| Runtime identity observed on the wire | `claude-cli/2.1.250 (external, sdk-ts, agent-sdk/0.3.250)` — recorded from the endpoint request the fake received, in every condition |
| Endpoint | `@yanlinglabs/winter-provider-conformance`'s `anthropicFake` routes on a `127.0.0.1:0` loopback server, closed in a `finally` (`withLoopbackFake`) |
| Environment | `officialCaptureEnv` — a REPLACEMENT env of `ANTHROPIC_BASE_URL` (the fake), `ANTHROPIC_API_KEY` (`sk-ant-fake-hermetic-key`), `CLAUDE_CONFIG_DIR` (fresh `mkdtemp`), `HOME` (a separate fresh `mkdtemp`), **plus the artifact's four traffic opt-outs** — `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`, all four declared in the pinned artifact's own non-credential registry; condition H adds one documented variable and says so |
| **Why the opt-outs are part of the measurement** | The fake proves the MODEL endpoint is loopback and can prove nothing about the child's other endpoints, which do not pass through `ANTHROPIC_BASE_URL`. Measured both ways on this pin (below): the request carries **21** tools with the opt-outs set and **25** without, and the advisor is one of the four that only appear when the remote fetch succeeds |
| Settings | `settingSources: []` — no user, project or local settings file is read at any level |
| Working directory | a fresh `mkdtemp` per condition; the whole temp root is removed in a `finally` |
| Requests observed | every condition: `HEAD /api/hello` then `POST /v1/messages`, both to the loopback fake. No other path reached the fake — and, with the opt-outs set, the child makes no other request at all; the first version of this record said "no network" while the child was fetching remote configuration behind the fake's back |
| **Egress, OBSERVED rather than inferred** | The fake can only see requests that reach IT, which is how "no network" survived as a false claim. One condition is therefore re-run with the child pointed at a loopback proxy that RECORDS and REFUSES (`NO_PROXY=127.0.0.1,localhost` keeps the model endpoint direct): it records **nothing**, and TWO controls make that a real observation rather than a wiring accident: a deliberate self-connection proves the listener records, and the same condition re-run with `NO_PROXY` removed proves the CHILD obeys the proxy (its own model request then goes through the listener). With the opt-outs removed the same listener records `CONNECT api.anthropic.com:443` |
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

**HERMETIC (the default legs, 2026-09-09, `darwin-arm64`, the four opt-outs set):**

| # | Condition | `init.tools` | advisor in `init.tools` | advisor on the wire |
| --- | --- | --- | --- | --- |
| A | default (model alias, `cwd`, `settingSources: []`) | 21 names | — none | — none |
| B | `tools: { type: "preset", preset: "claude_code" }` + `allowedTools: ["advisor", "Advisor"]` | 21 names | — none | — none |
| C | `tools: ["Read", "advisor"]` | 1 name (`Read`) | — none | — none |
| D | `systemPrompt: { type: "preset", preset: "claude_code" }` | 21 names | — none | — none |
| E | `settings: { advisorModel: <alias> }` | 21 names | — none | **— none** |
| F | `settings: { advisorModel: <alias> }` **and `tools: []`** | 0 names | — none | **— none** (and no tools at all on the wire) |
| G | `extraArgs: { advisor: <alias> }` (the CLI flag) | 21 names | — none | **— none** |
| H | the documented experimental enable variable, **no advisor model configured** | 21 names | — none | — none |
| I | as E, and the fake answers with a `server_tool_use` block named `advisor` | 21 names | — none | **— none** (the response block still arrives — see §3.4) |

**THE ONE NON-HERMETIC LEG** (`WINTER_D29_ALLOW_REMOTE_CONFIG=1`, same binary, same options, same
fake, run 2026-09-09 immediately after the table above):

| # | Condition | `init.tools` | advisor on the wire |
| --- | --- | --- | --- |
| E | `settings: { advisorModel: <alias> }` | 21 names | **`advisor_20260301` / `advisor`**, in a wire list of **25** |
| F | as E **and `tools: []`** | 0 names | **`advisor_20260301` / `advisor`** — the only tool on the wire |
| G | `extraArgs: { advisor: <alias> }` | 21 names | **`advisor_20260301` / `advisor`**, in a wire list of **25** |

The four wire entries that exist only in the second table — `DesignSync`, `Monitor`,
`PushNotification` and `advisor_20260301:advisor` — are the whole difference between the two legs.

The 21-name default inventory observed hermetically in A/B/D/E/G/H/I (a derived observation of the
running artifact, per WS-02 §2's "derived inventories", not a copied artifact):

```
Task, Bash, CronCreate, CronDelete, CronList, Edit, EnterWorktree, ExitWorktree, ListAgents,
NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskOutput, TaskStop,
WebFetch, WebSearch, Workflow, Write
```

The first version of this record printed a 24-name inventory including `DesignSync`, `Monitor` and
`PushNotification`. **Those three are not part of the pinned artifact's own tool surface; they are
remotely enabled**, which is the same finding as the advisor and is why every real-runtime proof in
this repository now runs with the opt-outs set (`HERMETIC_TRAFFIC_OPT_OUTS`, `src/testing/fakes.ts`).

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

**Not exposed by the pinned artifact at all. It is a REMOTELY-FLAGGED capability, and never a client tool.**

1. **Never in the session's advertised tool inventory, under any condition or either leg.** Including
   naming `advisor` in `tools` and in `allowedTools`: `system/init.tools` contains no advisor entry.
   The name is not a client tool in 0.3.250 — naming it does nothing at all. (Unchanged from the first
   version, and it is the point D29 actually rests on.)
2. **The pinned artifact, alone, never sends it.** With the four traffic opt-outs set,
   `settings.advisorModel`, the same setting beside `tools: []`, and the `--advisor` CLI flag reached
   through `extraArgs` ALL put no advisor entry on the endpoint request. The switch is not the
   session's configuration: it is the runtime's REMOTE FEATURE CONFIGURATION, and the session setting
   only matters once that has arrived and admits it.
3. **When it is sent, it is independent of the host's tool surface entirely.** In the non-hermetic leg
   with every builtin disabled (`tools: []`) the advisor schema is still sent and is then the *only*
   tool on the request. No allow-list, deny-list or alias the host controls can add it, remove it, or
   intercept it.
4. **It is an API-side server tool.** It reaches the model as a versioned server-tool schema, and its
   invocation comes back as a `server_tool_use` block rather than a tool call the host is asked to
   execute — condition I shows that block arriving verbatim EVEN in the hermetic leg, where no advisor
   tool was ever sent, because the block is the endpoint's answer rather than the client's request.
5. **A pin is not a pin for the tool surface.** The same binary, the same options and the same fake
   produce a 21-tool or a 25-tool request depending on a fetch to a CDN. WS-02 §6.1's "reviewed
   compatibility event" premise assumes the artifact's behaviour changes only when the pin changes;
   for the tool inventory that is true only when non-essential traffic is disabled. **A ruling is owed
   (controller): whether the PRODUCTION Options template sets the opt-outs by default.** WS-14 §3's
   "unless explicitly configured" already permits a router-set default; the README must say which way
   it goes.

## 4. Consequence for D29

* **The D29 split holds, and this probe is what makes it a measurement rather than an inference.**
  WS-06 D29 gives the Winter branch its own native `advisor` and leaves the official branch with
  Anthropic's API-side one; WS-14 §11's amendment says the Winter MCP server registered into the
  official branch "does NOT carry an advisor… `toolAliases` cannot intercept a server tool". Points 1,
  3 and 4 above are the direct evidence for exactly that: there is nothing on the official branch's
  client tool surface to alias, and nothing the router could put there that would take precedence.
  **The split is unaffected by F-1's correction** — it was never conditional on the advisor being
  sent, only on it never being a client tool, and that holds identically under both legs.
* **The router aliases neither advisor, and nothing in `src/` names one.** The official branch's
  advisor is the endpoint's; the Winter branch's is the Winter SDK's. There is no cross-branch
  aliasing, no proxying, and no reconciliation of the two — by design, and now by evidence.
* **One correction owed to WS-06/WS-14's wording (close-out, spec amendments).** Both currently read
  "Both branches therefore advertise `advisor` with the same empty schema." On the official branch at
  0.3.250 that is false in two ways: it is never *advertised* in the session's tool inventory, and it
  is not offered at all unless the runtime's remote feature configuration admits it. The honest
  statement is: **the Winter branch advertises `advisor` as a tool; the official branch offers
  Anthropic's server-side advisor to the model when the session configures an advisor model AND the
  runtime's remote feature configuration admits it — never through the tool inventory, and never at
  all when non-essential traffic is disabled.** A host that wants an advisor on the official branch must set `advisorModel` (WS-06 D30's
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
  above is untested here.
* **What the remote configuration actually keys on is NOT established.** The non-hermetic leg shows
  the fetch changes the answer; it does not show what the CDN keyed on (the artifact version, a
  percentage rollout, the absence of an account, the day). The first version of this record asserted
  "identical on darwin-arm64 and linux-x64" — that agreement is now known to have been agreement about
  a remote answer, not about the artifact, and is withdrawn.
* **Nothing about behaviour after the tool fires.** The fake never returns a real advisor result; the
  probe measured what is *sent* and what is *surfaced*, not what an advisor round-trip does.
* **The hermetic legs are the ones that generalise.** They depend on the artifact and nothing else,
  which is the whole point of F-1's fix: `darwin-arm64` locally and `linux-x64` in CI now measure the
  same thing on any day. The test runs the same way anywhere the pinned platform binary installs, and
  skips with a printed reason where it does not.

## 6. Consequence reversed by R-8-1 (2026-09-11)

**Everything measured above still stands. Only §4's POLICY CONCLUSION — what the router does with
that measurement — is reversed.** The user's tool-ownership ruling R-8-1 (Winter 8b prerequisites)
supersedes the old refusal: Winter's default tools, `advisor` among them, are pulled by the router and
bound under Claude's built-in names on the official branch too, so `winterMcpServerDescriptor` no
longer throws when a capability list names one — `assertNoAdvisor` is retired, and an `advisor`
descriptor now survives into `descriptor.tools` and `canonicalToolNames` under
`mcp__<brand>__advisor`, exactly like any other capability plugin.

This is NOT a finding that contradicts §§1–4 above. Nothing about the PINNED ARTIFACT changed or was
re-measured: Anthropic's API-side `advisor` server tool is still never a client-side tool on the
official branch (point 1), still gated by the runtime's own remote feature configuration rather than
by anything the session or this router configures (point 2), still unreachable by any allow-list,
deny-list or alias the host controls (point 3), and still surfaces as a `server_tool_use` block rather
than a tool call the host executes (point 4). What changes is only whether WINTER ALSO offers its own,
client-side `advisor` on this branch — it now does, backing rather than replacing Anthropic's, and a
model on the official branch that calls Winter's `mcp__<brand>__advisor` gets Winter's own reviewer
plumbing regardless of whether the CDN-gated API-side one is present that session. A host that wants
BOTH consequences legible should read this section beside §4 rather than in place of it.
