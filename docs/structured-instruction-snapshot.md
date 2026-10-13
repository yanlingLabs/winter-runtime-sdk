# Structured current guidance snapshot

`loadStructuredInstructionSnapshot` records structured guidance during the same
walk and import expansion used by `loadInstructionSnapshot` and `buildRunHome`.
It creates no run home, settings/MCP/items/hooks discovery, storage or cached
snapshot. The legacy API's keys, text, digest, provenance order and ordinary Code
behavior remain unchanged. The public `expandImports.onRead(path, text)` callback
still receives exactly two arguments; richer recording is private.

The new API returns frozen plain data:

- `text`, `digest`, `files`, `skippedLinks`, `droppedImports`: the legacy results.
- `tiers`: `all` by default, or explicitly `admitted-only`.
- `blocks`: requestedPath, admittedPath, tier, text, textSha256. Text is the exact
  expanded/import-neutralized body with the existing trailing newline. Rebuilding
  `# requestedPath\n\n` plus each body, joined with `\n`, reproduces text and digest.
- `provenance`: requestedPath, admittedPath, tier, unexpanded decoded text,
  textSha256, depth and optional importerPath/importerAdmittedPath. Top level is
  depth zero; direct imports are depth one; the existing maximum is five.

`textSha256` hashes UTF-8-decoded text encoded back as UTF-8. Invalid input bytes
become U+FFFD under the existing reader semantics; this is not a hash of original
file bytes. Expanded block hashes and unexpanded provenance hashes intentionally
measure different text. Existing legacy `files.sha256` semantics are unchanged.

Requested paths govern Code discovery and relative import resolution. Admitted
paths name the file actually read. `importerPath` remains the requested containing
identity, compatible with the current parent resolver's requested-path lineage;
`importerAdmittedPath` separately records the actual containing identity. A
symlinked import still resolves its nested relative imports against its requested
location, never silently against the real file's directory. No additional read or
symlink walk is needed for this recording.

`admitted-only` skips the ordinary personal/user source **before any content read
or hash**, including its imports. It does not grant authority to the remaining
roots: host admission and protected guest ownership remain independent. The
legacy `loadInstructionSnapshot` always uses its ordinary all-tier behavior,
even if a structurally wider caller supplies a tiers field. No personal or memory
scope is invented here. A test-only beforeInstructionRead observation hook pins
pre-read omission; it is not a file-access authorization hook.

Every successful existing read occurrence is retained in depth-first encounter
order. No deduplication changes Code semantics. In particular, diamond imports
(A→B→D and A→C→D) record D twice; WINTER.md importing WINTER.local.md records that
file as an import and later as its discovered top-level block. Real cycles remain
subject to the existing branch-local seen set, unresolved depth-six/missing tokens
stay neutralized literals, and dropped/skipped data stays visible.

**Current consumer compatibility limit:** Winter's parent resolver at cb94818e,
`packages/core/src/cowork/current-context-resolver.ts` validate(), refuses duplicate
requested/admitted paths. Therefore those legitimate diamond or import-then-
top-level layouts currently fail closed with context_unavailable. This seam is
not a drop-in guest reader for that resolver. Before reader wiring, an independently
reviewed occurrence-aware, same-hash lineage rule must admit legitimate repeated
reads while still refusing ancestor cycles and contradictory text. Do not hide
this mismatch by deduplicating the SDK output.

The API is a source seam, not a protected reader or transport. Its provenance is
local filesystem evidence, not host authorization or a globally atomic revision.
Consumer projection must bind canonical owning query/backend/boot/generation,
validate/request appropriate tiers and roots, preserve requested/admitted alias
mapping, enforce physical confinement and bounds, and revalidate current authority.
No guest profile, RPC, native/VM admission, personal/memory authority, SDK pin,
package version, release or product activation is added.

Source verification: `bun test ./test` passes 716 tests / 3359 assertions across
51 files, including the brand gate and eight structured snapshot fixtures.
`bun run typecheck` passes; `bun run build:packages` emits both package entries.
Focused snapshot/import tests pass 43 tests / 230 assertions. Retained local logs
are under `out/structured-instructions/{tests,types,build}.log`, excluded from
this source commit. No emitted package was published or admitted for guest use.
