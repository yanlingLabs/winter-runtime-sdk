# Structured instruction read and expansion limits

`loadStructuredInstructionSnapshot` accepts optional input-only limits:
maxFileBytes, maxReadBytes, maxReadOccurrences and maxExpandedBytes. All four are
positive safe integers. Maximum accepted ceilings are respectively 128 KiB,
256 KiB, 256 content-read occurrences and 128 KiB. Lower values are allowed;
unknown/missing/accessor fields or values outside the ceilings refuse before
content reads. Limits are not added to the eight-key structured result.

Absent limits retain the existing behavior. `loadInstructionSnapshot`, run-home
construction and public `expandImports` never opt into these limits. Legacy/default
Code output, SHA/provenance order and the two-argument onRead callback stay unchanged.
No truncation or partial snapshot is returned. Limit failure has the dedicated,
path-free run_home_instruction_over_bound code; invalid scope or missing required
shared guidance retains run_home_instruction_refused.

Bounded content reads use held readonly descriptors. Repository/shared reads
retain the existing nofollow/nonblock, regular-file, current realpath containment
and device/inode checks in readAdmittedFile. The optional internal budget changes
only descriptor content reading. Its specific failure propagates through the walk
catch; ordinary filesystem refusals preserve their existing semantics. Explicit
bounded all-tier user reads retain their ordinary broader user path semantics,
with regular-file/nonblocking descriptor reads. No personal scope is admitted.

A known oversized regular-file size refuses without reading content. Otherwise
an 8 KiB buffer loop requests no more than the remaining allowance plus one probe
byte. A file that grows while read is refused at that single overflow byte; the
loop cannot consume the unbounded growth. Per-file and cumulative budgets count
actual read bytes. A streaming UTF-8 decoder independently bounds per-file and
cumulative decoded text encoded back as UTF-8 before retaining each decoded chunk.
Invalid-byte replacement can expand text and therefore refuse even when raw bytes
fit. BOM is preserved like Buffer.toString/readFile('utf8'); multibyte sequences
spanning chunks and incomplete trailing sequences keep the existing decoding.

Every content read counts as an occurrence, including repeated imports in diamonds
or sibling branches and an import later loaded as top-level guidance. Remaining
read budgets apply before the next descriptor content read. Successful records
remain in the same order; the recorder never rereads a file.

The existing markdown/import algorithm uses shared bounded append/join operations.
Literal segments, code-span/fenced lines, recursive replacement results and line
separators are checked before retaining/joining growing strings. Import-token
neutralization, the trailing newline, path headings and separators between files
are included in the expanded budget. Recursive intermediates and the final headed
aggregate must fit; an expansion does not get to allocate its oversized aggregate
first and refuse afterward. SHA and structured recording still measure the exact
same decoded/raw or rendered text as the unlimited path.

A test-only onInstructionReadChunk observer exposes byte/occurrence counts, no file
descriptor or filesystem capability. Portable tests append to their own disposable
fixture during a read to demonstrate the limit+1 cutoff. They cover static/growing
files, repeated reads, raw/decoded UTF8 limits, BOM/split/invalid decoding, recursive
and multiline expansion, neutralization/headings, required shared/import refusals,
invalid schemas and unchanged legacy/default goldens.

These are resource bounds, not race-proof filesystem confinement, an atomic file
snapshot or authenticated reader admission. They do not strengthen the existing
Code path checks into a kernel boundary. Protected guest views, native identities,
canonical generation/alias authorization, personal/memory scope handling and the
reader/transport still require independent implementation and admission. No guest
profile, executable trust, VM/native run, SDK pin, version, release or activation
is added here.

Verification: `bun test ./test` passes 727 tests / 3399 assertions across 52 files.
`bun run typecheck` passes; `bun run build:packages` emits both package entries.
The focused bounded/legacy/structured tests passed 45 tests / 211 assertions before
the additional required-shared/import refusal case. Local logs are retained under
`out/bounded-instructions/{tests,types,build}.log`, excluded from the source commit.
No emitted package was published or admitted for guest/native execution.
