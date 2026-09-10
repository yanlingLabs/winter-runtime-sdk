# Advisor-alias probe — what 0.3.250 does with an alias key that is not one of its own built-ins

**Ruling:** R-8-1(3) (the user's tool-ownership ruling, 2026-09-11), through P-6 of the 8b-prerequisites
plan: *"The router retires `assertNoAdvisor`; widening `ALIASED_BUILTINS` to `advisor` is GATED on R4's
measurement of what 0.3.250 does with an alias key that is not a local built-in."*

**Why it had to be measured.** `SendMessage` and `ListAgents` are names the pinned runtime already
carries as LOCAL built-ins, so aliasing them redirects a lookup that would otherwise have resolved
locally. `advisor` is not one of those: `docs/probes/d29-advisor.md` measured Anthropic's advisor as an
API-SIDE server tool (`advisor_20260301`, no input schema, returned as a `server_tool_use` block) which
the four traffic opt-outs remove from the session entirely — so on the pin there is no local `advisor`
for an alias to shadow. Whether the runtime's single-hop alias table accepts a key it has no built-in
for, ignores it, or refuses it was unknown, and a widening the pin quietly ignored would be a door the
model could never walk through.

**Pin:** `@anthropic-ai/claude-agent-sdk` 0.3.250 (the platform binary in this repository's own
`node_modules`, never a binary on `PATH`). **Measured:** 2026-09-11.

**Reproduce:** `bun test test/official/runtime-aliases.test.ts -t "R4"` — four hermetic sessions of the
real runtime against a scripted `127.0.0.1` loopback fake, with the branch's four traffic opt-outs set
by the production env builder (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`,
`DISABLE_ERROR_REPORTING`, `DISABLE_AUTOUPDATER`), asserted present in the child environment by the test
itself. The test asserts only that the turn completed, that the run was hermetic, and that THIS FILE
records what it observed — never that an observation came out one way. A change in the runtime's
behaviour therefore fails the test rather than leaving this document quietly untrue.

---

## 1. The conditions

| | |
|---|---|
| standing server | `winterMcpServerDescriptor` with the two messaging tools PLUS an `advisor` capability descriptor (`{ question: string }`), materialized into the official branch by `officialMcpServers` |
| alias map | the brand's own (`SendMessage`, `ListAgents`) plus `advisor → mcp__winter__advisor` |
| the model | the loopback fake, scripted to emit exactly one `tool_use` block per condition — so a BARE `advisor` block is emitted regardless of what the session advertises |
| condition 1 | bare `advisor` block, alias present |
| condition 2 (the control) | bare `advisor` block, **no** alias entry, same descriptor registered |
| condition 3 | bare `advisor` block, `disallowedTools: ["advisor", "mcp__winter__advisor"]` |
| condition 4 | canonical `mcp__winter__advisor` block, same deny rule |

Condition 3/4's deny list is spelled by hand because `aliasDenyNames("advisor", brand)` does not
type-check today — its parameter is `AliasedBuiltin`, derived from `ALIASED_BUILTINS`, which is what
this measurement gates. The two names are exactly what the helper returns after the widening
(`[builtin, aliasTargetFor(builtin, brand)]`).

## 2. What was observed

```measured
pin: @anthropic-ai/claude-agent-sdk 0.3.250
measured-on: 2026-09-11
init-tools-advertise-canonical-advisor: yes
init-tools-advertise-bare-advisor: no
wire-advertises-canonical-advisor: yes
wire-advertises-bare-advisor: no
bare-advisor-reaches-the-mcp-handler: yes
bare-advisor-reaches-the-mcp-handler-without-the-alias: no
bare-advisor-tool-result-is-error: no
deny-blocks-the-bare-call: yes
deny-blocks-the-canonical-call: yes
```

**(a) The advertised set.** `system/init.tools` carries 26 names, and `mcp__winter__advisor` is one of
them; there is no bare `advisor` entry anywhere in it. The wire's own `tools` array (the first
`/v1/messages` request) carries the same set, differing only in the vendor's local name for its
subagent tool (`Task` in `system/init`, `Agent` on the wire). Verbatim, from the run of 2026-09-11:

```
Task, AskUserQuestion, Bash, CronDelete, CronList, Edit, EnterPlanMode, EnterWorktree, ExitPlanMode,
ExitWorktree, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill,
TaskOutput, TaskStop, WebFetch, WebSearch, Workflow, Write, mcp__winter__advisor,
mcp__winter__list_agents, mcp__winter__send_message
```

So the standing server's advisor IS visible to the model on this branch — under its canonical name,
and only under it. (This is the surface `assertNoAdvisor` used to forbid; it exists here because R-8-1
reversed that refusal.)

**(b) A model-emitted bare `advisor` block, with the alias configured, REACHES THE MCP HANDLER.** The
handler recorded the call and the model saw its answer as this tool call's own result:

```json
{"tool_use_id":"toolu_advisor_bare","type":"tool_result","content":[{"type":"text","text":"advice: ship it"}]}
```

no `is_error`, and the session ended `result`. **The control is what makes this a finding rather than a
coincidence:** the identical block, with the identical descriptor registered and the alias entry
REMOVED, does not reach the handler at all —

```json
{"tool_use_id":"toolu_advisor_control","content":"<tool_use_error>Error: No such tool available: advisor</tool_use_error>","is_error":true}
```

— so it is the alias, and nothing else, that resolved the name. **0.3.250's `toolAliases` does not
require its key to be one of the runtime's own built-ins.** Single-hop name-based resolution of a
model-emitted `tool_use` block is applied to the key as given.

**(c) The deny rule removes both names.** With `disallowedTools: ["advisor", "mcp__winter__advisor"]`
the bare call is blocked and the canonical call is blocked. Consistent with row 3's measurement (the
deny check runs AFTER alias resolution, so the resolved name is the one that bites), the canonical half
is the half that does the work — and `aliasDenyNames` is what keeps a host from having to know that.

## 3. Consequence

- **The gate is PASSED: `ALIASED_BUILTINS` may be widened** with `{ builtin: "advisor", tool: "advisor" }`.
  The pin honours the alias, so the widening buys a real door: a model that emits a bare `advisor`
  block — the name Claude's own built-in advisor would carry — is served by Winter's advisor on the
  standing server, which is exactly R-8-1(3)'s "Winter's advisor backs Claude's". The widening
  automatically widens `AliasedBuiltin`, `aliasTargetFor`, `aliasDenyNames` and, through
  `containment.ts`, `officialDisallowedTools`.
- **It is not required for reachability.** The canonical name `mcp__winter__advisor` is advertised with
  or without the alias, so the model can always reach the tool by its canonical name; the alias only
  adds the bare spelling. A host that denies the advisor must deny BOTH names either way.
- **This does not contradict `docs/probes/d29-advisor.md`.** That probe's subject is Anthropic's own
  API-side advisor, which is still absent from a hermetic session and still arrives as a
  `server_tool_use` block when it is present at all. Nothing here aliases or intercepts it; what is
  measured here is a Winter-owned MCP tool that happens to share its bare name.

## 4. What this probe did NOT establish

- Nothing about the alias under a session where Anthropic's own advisor IS active (that needs the
  remote feature configuration this branch opts out of by default). If both were ever live at once, the
  precedence between a `toolAliases` key and an API-side server tool of the same bare name is unmeasured.
- Nothing about Tool Search or deferral: the pinned SDK surface exposes no control for it, so the
  canonical advisor is advertised eagerly like the other canonical twins (row 2's finding, unchanged).
- Nothing about the advisor's own behaviour — the handler here is a recording fake. R9's
  `advisor-binding.test.ts` is where the real handler, over the session's own transcript, is proved.
