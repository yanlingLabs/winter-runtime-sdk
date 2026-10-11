# Authenticated guest runtime transport

`createGuestQueryTransport` is a separate query door over a host-injected guest
process channel. It does not materialize a local RunHome or relax the local
run-home identity checks. The host supplies admitted guest paths and non-secret
environment. Unsupported options and legacy host credential/messaging callbacks
refuse rather than becoming a guest escape capability.

Preparation validates the protected guest runtime and required capabilities
before opening a process. Every opening has a fresh host-minted launch attempt
ID, in addition to workspace/session/incarnation/lease and launch revision
identity. Connections and events must match both. Launch revisions describe the
admitted launch snapshot; they never replace current authorization checks for
later tool, source, provider or broker effects.

Cancellation before opening starts no process. Cancellation or timeout during
an unacknowledged open is uncertain and calls `cleanupRuntimeAttempt` using the
host's expected identity/attempt. That authenticated channel operation must close
late-launch admission and retain ownership until cleanup is proven. A foreign or
stale returned connection is never signalled or sent input. Matching owned stream
failure requests termination without claiming that the request itself proves
termination. Lost effects are never blindly replayed.

Output and queued input have independent byte and entry bounds; empty chunks
are no-ops. Input writes are ordered, stop prevents queued/new delivery, and the
event reader does not wait behind a hung signal acknowledgment. The SDK retains
its own NDJSON/control framing. Guest handles never pretend to be Mac PIDs.

The 14 focused tests include a real SDK query over a fake authenticated channel,
foreign/late handshakes, cancellation races, malformed/stale events and backlog
limits. They do not run a Linux VM, restore durable guest agents, supply an
authenticated supervisor or implement confined tools. The runtime's separate
confined-guest posture still refuses until those execution routes are available.
