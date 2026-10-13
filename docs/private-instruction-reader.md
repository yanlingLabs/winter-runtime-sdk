# Private one-shot guidance reader source

`src/guest/instruction-reader.ts` contains a private callable function,
readInstructionFrame. It has no public package/index export, CLI, autorun, stdout
write or process launch. A future separately admitted Root-isolated reader entry
may call it; ordinary SDK/profile/query paths do not enable it.

The invocation is a closed, deeply frozen plain/null-prototype Root-created data
object: version=1, lowercase v4 readId, six owner correlation fields
(logicalSessionId, backendSessionId, generation, bootId, incarnationId, leaseEpoch),
four physical view paths (sourceRoot, sourceCwd, sharedRoot, sharedPath), and four
limits. IDs are bounded to 128 UTF-8 bytes, paths to 4096. Paths refuse C0/DEL,
backslash and unpaired UTF-16 surrogates; normal spaces and Unicode remain valid.
Cwd stays within source;
sharedPath is exactly sharedRoot/WINTER.md. Source/shared/read-home path scopes cannot
overlap lexically; this is not a physical mount/identity proof. Limits must exactly equal the reviewed 128 KiB file / 256 KiB cumulative
read / 256 occurrences / 128 KiB expansion constants. No env, cwd-of-process,
brand, executable config, provider, personal or memory selection is accepted.
Frozen shape, read IDs and this module are **not native admission or authority**.

Root selects physical view paths. Portable tests use actual temp views without a
namespace projection. The future native entry must restrict these to its fixed
registered source and protected shared guest views, recheck owning generation and
pending correlation, and refuse unregistered/caller-JSON authority. The original
Core request/registration remains with the host adapter; this module neither
imports Core nor rewrites the Core shared alias/DTO.

One call invokes the actual loadStructuredInstructionSnapshot exactly once with
tiers=admitted-only, trustedProjectRoot=null, explicit source root/cwd, required
shared scope and the fixed four limits. Home and the loader's userHome boundary
are both /run/winter/instruction-reader; ambient Mac homedir cannot choose the
instruction scope. No user-tier, memory, settings, MCP or hooks are discovered.
There is no cache or fallback; replacement at the next fresh call is reread.

Return is one JSON line containing the normalized invocation echo plus the actual
eight-key structured snapshot. Request JSON is bounded to 16 KiB before filesystem
work; output including its newline is bounded to 320 KiB. Serialization checks
JSON-escaped string-token sizes before encoding/retaining them and bounds the
running frame before joining. It never parses instruction headings or truncates
content. Large legitimate duplication/path-rich snapshots may fit loader budgets
but exceed this stricter frame cap and therefore refuse. Any malformed invocation,
loader/budget/serialization failure becomes only instruction_reader_unavailable,
without original paths, content or errors. Dropped/skipped guidance remains in the
actual snapshot; the host's v1 mapper must refuse it.

The module does not write stderr. Root must separately enforce the actual stdout
pipe bound, a 16 KiB diagnostic stderr bound, exit0 plus exactly one valid frame,
and a wall deadline below the parent resolver's five seconds. Timeout/owner loss
must kill/reap/drain with retained debt on uncertainty, never infer cleanup from
EOF or JSON. There is no pending-reader/native lifetime implementation here.

The future measured compiled entry must disable Bun config/dotenv and other
supported executable autoload mechanisms, use a fixed empty Root-owned RO process
cwd /run/winter/instruction-reader and closed environment including HOME there,
close residual FDs, and run in the separately reviewed reader identity/view with
no protected stores/config/network and strict syscall/resource limits. The normal
function's planted config tests are **not** proof of compiled autoload flags, FD
inventory, namespace/UID confinement or library closure. Those are native gates.

The walk.ts comment now accurately describes realpath/stat/inode comparisons as
ordinary Code guardrails. Separate lookups do not defeat coordinated ancestor
outside/inside/outside replacement. No walk code or legacy behavior is changed.
The private reader plus bounds does not prove confidentiality, physical containment,
strict tier attribution or an atomic multi-file snapshot. Those require the native
view and, for stronger attribution, a separately reviewed kernel resolution adapter.
No VM/native fixture, profile activation, consumer pin, version or release follows.

Source verification: `bun test ./test` passes 739 tests / 3542 assertions across
53 files. Reader plus brand-gate fixtures pass 22 tests / 191 assertions. Typecheck
and both existing public package entries build successfully; no reader executable
or process fixture is built. Logs are retained under uncommitted
`out/private-reader/{tests,types,build}.log`. Twelve reader fixtures use disposable
files and normal callable source execution only, never a native compartment.

The future entry must JSON-parse its OWN bounded stdin and deep-freeze plain data
objects before reflecting or calling this function. Frozen Proxy reflection can
execute traps; this callable function cannot generically detect Proxy objects and
is not an authority boundary. Its closed frozen-shape checks do not authenticate
a Root caller or replace the separately admitted native channel/view.

The final path-grammar follow-up logs are retained as
`out/private-reader/followup-{focused,tests,types}.log`. No fixed reader-home
filesystem is touched by these tests.
