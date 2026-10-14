# Guided provider fixture source

This private, inert fixture implements the existing `GuestProviderPort` byte
exchange contract. Importing it creates no socket, listener, process, engine,
credential lookup, filesystem read or external request. It is not exported by
RuntimeSDK and adds no provider, release, consumer pin or activated profile.
`protocol-source.json` binds the inspected SDK client/type sources as DATA;
it neither imports those sources nor verifies native admission.

Root supplies a closed script as UTF-8 `JSON.stringify` bytes and an independently
selected SHA256. `createGuidedFixturePort(scriptBytes, expectedScriptSha256)`
checks the digest before constructing the port. Script shape:

```ts
{
  version: 1,
  scope: { homeId, workspaceId, sessionId, backendSessionId, taskId,
           incarnationId, bootId, leaseEpoch, grantRevision,
           accountRevision, modelRevision },
  selection: SELECTION,
  steps: [
    { system: ["host fact", "host publication obligation"],
      user: ["old shared guidance", "source root", "source cwd"],
      response: "first deterministic answer" },
    { system: ["host fact", "host publication obligation"],
      user: ["edited shared guidance", "source root", "source cwd"],
      response: "second deterministic answer" }
  ]
}
```

The selection reproduces the previous disposable host-query fixture's public
`openai/gpt-5.6` metadata. It cannot route anywhere: the only operations here are
normalized private `begin`, `next` and `cancel` frames. Unknown script/envelope/
turn keys, other selections/models/scopes, bad framing, UTF-8, duplicate keys,
wrong sequences/ordinals, replay, missing/reordered markers or a third begin
refuse and close the fixture. Requests are bounded by the SDK's 2 MiB + 4096-byte
request limit. Scripts are bounded at 64 KiB, each step at 32 markers per role,
and each marker/response at 4096 bytes. Exactly two serial invocations are allowed.

Each accepted begin receives `accepted`; two subsequent pulls receive
`text_delta` and `done(end_turn)`. The port preserves the SDK's exact invocation
ID and exchange sequence in responses. It does not replace `guestProviderFor`,
`adapterAsProvider`, native ownership or required-context plumbing. Future admitted
integration must route the actual engine through those real implementations.

SYSTEM expectations match the actual normalized `turn.system`; provided cache
blocks must join to exactly those bytes. USER expectations match only message 0,
which must be the current `userContext` (`role:user`, `isMeta:true`). Markers must
occur in the Root-selected order. Historical user/assistant messages cannot meet
the current-guidance requirement. The initial fixture accepts text-only content
and ordinary tool declarations; it does not support tool-result/image/thinking
content, native-state continuation, midconversation system roles or tool events.
JSON schema/attachment payloads remain inert data. Marker matching is an oracle
for selected facts/guidance, not a complete semantic validation or provenance,
atomic-snapshot, personal/settings-read or publication-policy proof.

`receipt()` returns frozen snapshots containing each complete ACTUALLY RECEIVED
accepted turn and its SHA256 over recursive key-sorted JSON. Turn digesting retains
engine UUIDs/cache keys; expectations do not depend on their values. Receipts also
hold the verified script digest and monotonically increasing ingress counters:

- `receivedFrames`: every `exchange` call, including malformed, closed or aborted
  input, counted before decoding/authority checks.
- `receivedBegins`: every decoded `operation:begin`, including refused/closed
  begins, counted before scope/model/sequence/marker checks. Malformed bytes are
  represented by `receivedFrames`; their operation is not guessed.
- `acceptedBegins` and `completed`: separate acceptance/completion observations.

Neither script nor request can supply those counters. To prove the later
post-revocation zero case, the independent future parent must retain this port's
receipt before refusal and compare received counters after actual attempted
engine work. Closing the port and observing no calls in an injected unit test
does not demonstrate required-context enforcement. A received closed begin still
increments both ingress counters. `close`/abort/cancel fence this deliberately
narrow one-shot fixture; cancellation does not model the production client's
more general invocation-local reuse/concurrency behavior.

The future source/artifact packet must bind the exact stub source hash, script
hash, protocol sources and complete compiled dependency closure before execution.
This module has no executable entry point, no native peer/owner validation and no
Root registration. Receipts explicitly retain `engineDispatchProven:false` and
`nativeAdmissionProven:false`; native/VM/egress/connector/production/cold/child
proof and all current automatic-review holds remain outstanding.

Portable verification (no listeners, subprocess fixture or engine dispatch):

```sh
bun test scripts/guest-guided-provider/stub.test.ts
node node_modules/typescript/bin/tsc --noEmit -p scripts/guest-guided-provider/tsconfig.json
```

Local worktree verification used already installed compiler/type DATA from the
RuntimeSDK checkout, with no install or dependency edits:

```sh
node ../../winter-runtime-sdk/node_modules/typescript/bin/tsc --noEmit -p scripts/guest-guided-provider/tsconfig.json --typeRoots ../../winter-runtime-sdk/node_modules/@types
```
