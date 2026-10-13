# Private compiled reader entry source and pending recipe

`src/guest/instruction-reader-entry.ts` is the distinct compiled-role entry. It
runs only when it is the main module. Ordinary imports, public package exports,
existing query profiles and the private callable reader are unchanged. This is
source preparation, not a built/admitted Linux role.

The initial misuse check requires Linux/PID1, real=eUID>=1000, primary real/eGID
matching UID, process.execPath=/instruction-reader, process.argv.slice(2) exactly
--instruction-reader-v1, cwd=/run/winter/instruction-reader and the exact six-key
environment from the reviewed C source: LANG=C, LC_ALL=C, TZ=UTC,
HOME=/run/winter/instruction-reader, TMPDIR=/tmp, PATH=/usr/bin:/bin. Bun's compiled
argv/execPath compatibility is still unexecuted. These checks do not mint any
native owner/admission capability or prove isolation. Root must reserve/verify
reader UID against ACTUAL tool/runtime UIDs, independently attest executable,
mount/view/current owner and reap/drain lifecycle. Shape/IDs are not authority.

After that guard, stdin is read in bounded chunks through EOF. It may contain one
compact JSON object with no whitespace or trailing LF, never a second frame. At most16KiB plus one
probe byte is consumed before UTF8 decoding/parse. Invalid UTF8, BOM, empty,
truncated/extra JSON, non-object or excessive nesting refuses. After parsing,
JSON.stringify roundtrip must match the original decoded input byte-for-byte,
rejecting duplicate keys, escaped aliases, whitespace and unsafe-number changes.
Root's Python producer must use separators=(",", ":"), ensure_ascii=False, safe
integers and closed keys so literal Unicode paths match the JavaScript serializer.
Only OWN parsed
plain JSON objects are recursively frozen; there are no caller Proxy objects.
Registered source roots are /workspace/folders/<id> or /workspace/repos/<id>,
with the same safe ID grammar as the C plan. Cwd must stay in that root; shared
root/file must be the fixed protected view. The private reader still validates
closed fields, correlation, limits and paths before its actual loader call.

The private readInstructionFrame is invoked exactly once. Output is validated as
one newline-terminated JSON object, capped at320KiB, with exact input echo and the
actual snapshot's eight keys, then fully synchronously written with partial/EINTR handling
(no background queue). Interrupt retry is bounded. Errors produce only a fixed
instruction_reader_unavailable line on stderr and nonzero exit; no exception,
guidance body, environment or configuration is logged. A partial stdout write
followed by failure is not success; Root must reject it; EPIPE never retries the partial data as a new frame. Root enforces actual pipe
byte caps, exit0 plus one valid correlated frame,4s deadline, kill/reap/drain and
debt retention. The source helper does not simulate or prove cleanup.

The native launcher must provide only fds0/1/2 and independently prove no sockets
or original source/shared/store/closure handles survive. It must supply the new
PID/network/IPC/mount namespaces, readonly views, reserved UID/groups and resource
limits. This entry cannot infer those conditions from path or process facts; no
proc probing, namespace change, native owner minting or fallback launch is added.

## Mandatory source compile recipe — NOT executed/admitted

A future separately reviewed multi-origin build must pin this repository source,
the actual SDK dependency/compiler, verified official Linux base, Root/C sources,
full immutable closure and all input/output receipts. Build from a fixed empty
Root-owned build directory, never a source cwd. The pinned Bun1.3.14 help exposes
all four required flags; none may be omitted even where a default is false:

```text
<verified-compiler> build --compile \
  --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
  --no-compile-autoload-tsconfig --no-compile-autoload-package-json \
  --target=bun-linux-arm64 --compile-executable-path=<verified-linux-base> \
  --metafile=<output>/instruction-reader.metafile.json \
  <sealed-source>/src/guest/instruction-reader-entry.ts \
  --outfile=<output>/instruction-reader
```

The execution recipe is fixed by Root: /instruction-reader --instruction-reader-v1,
empty RO cwd/home, exact environment, no inherited options or executable config.
Before native admission, plant bunfig preload, dotenv, tsconfig and package.json
at source root/cwd and prove none affect the actual compiled process. Portable
module tests cannot prove those compile flags, library compatibility or namespace
confidentiality. No Linux reader artifact or native/process fixture was built here.

Tests inject byte sources/writers and a reader callback; one explicitly projects
registered guest paths to disposable temp files for the ACTUAL current loader,
then restores only the invocation echo. Its snapshot paths remain temp evidence;
this is neither unmodified guest output nor a native mounting/ownership proof.
No personal/memory scopes, transport/profile activation, consumer pin, release,
VM/GUI/native launch or immutable B change follows.

The current C filter permits getrandom; no-dev/JSC entropy and all Bun runtime
syscall/library/argv compatibility remain explicit native gates. No portable
framing test establishes that the compiled role can run under that filter.

Source verification: `bun test ./test` passes756 tests /3612 assertions across54
files; focused entry/framing tests pass17 /70 assertions. Typecheck passes.
Logs are retained under uncommitted `out/instruction-reader-entry/{tests,types}.log`.
The four autoload flags were verified using local pinned Bun's help only. No
Linux compiled reader artifact, role process, namespace or fixture was run/built.
