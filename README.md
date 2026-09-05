# winter-runtime-sdk

One door over two agent runtimes. A host that wants both the Winter Agent SDK and the official
Claude Agent SDK talks to this package as a single SDK: the same `query()`, the same `Options`, the
same closed `SDKMessage` union — plus runtime-selection inputs.

Decision record: WS-00 D19 (2026-09-05). Boundaries that do not move:

- `@yanlinglabs/winter-agent-sdk` stands alone for Winter-only hosts and never learns this package
  or the official runtime exists.
- This package is a selector and an adapter, never a translation layer: Options and the message
  stream pass through verbatim. It owns runtime selection (the D13 rule), the official-SDK adapter
  (Options template, spool env, supervised spawn proxy, mirror errors, tool aliases and deny floor,
  builtin-path containment, Winter MCP plugin registration), shared session-store wiring, the
  cross-runtime handoff barrier with the materialized-resume decoration doors, and the runtime
  directory plus cross-runtime messaging router.
- The host vendors all three packages directly (`winter-runtime-sdk`, `winter-agent-sdk`,
  `claude-agent-sdk`); this package declares the two SDKs as peer dependencies and receives their
  module instances by injection, so a host that never creates a Claude session never loads the
  official runtime and no SDK is ever instantiated twice.
- A `brand` profile flows through unchanged (Winter defaults); Claude Code's own literals stay fixed.

Status: repository created ahead of Phase 7 of the Winter arc; no code yet.
