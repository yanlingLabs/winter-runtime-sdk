// @ts-nocheck -- thin runner. Its relative imports resolve only inside the staged guided packet
// (source/builder/... beside source/runtime/...); the repository typecheck must not follow them.
/** Guided providerWorker. Drives the RuntimeSDK guided provider fixture (stub.ts) behind the native owner's provider
 * symbols and COUNTS every request it receives. It has no credential, no listener of its own, no socket creation, no
 * network client and no child process: it only accepts on the inherited listener descriptor. Contract C-P1..C-P11 is in
 * scripts/guest-guided-build/README.md; every decision lives in provider-worker-core.ts and is tested there. */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { fstatSync, readFileSync, writeSync } from "node:fs";
import { createGuidedFixturePort } from "../../../../runtime/scripts/guest-guided-provider/stub.ts";
import { PROVIDER_EXIT, PROVIDER_FDS, PROVIDER_LIMITS, ProviderStartupRefusal, checkImmutableInput, checkStartup, createProviderCounter, parseMetadata } from "./provider-worker-core.ts";

function line(text: string): void {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length;) { try { at += writeSync(1, bytes, at); } catch (error) { if (error?.code !== "EINTR") throw error; } }
}

async function main(): Promise<number> {
  try { checkStartup(process.platform, process.argv.slice(2)); } catch (error) { return refusal(error); }
  let port, counter, metadata, library, ownerFd = -1, reason = "failure";
  try {
    checkImmutableInput(fstatSync(PROVIDER_FDS.library), PROVIDER_LIMITS.libraryBytes);
    checkImmutableInput(fstatSync(PROVIDER_FDS.metadata), PROVIDER_LIMITS.metadataBytes);
    metadata = parseMetadata(readFileSync(PROVIDER_FDS.metadata));
    port = createGuidedFixturePort(metadata.scriptBytes, metadata.scriptSha256);
  } catch (error) { return refusal(error); }
  counter = createProviderCounter(port, line);
  try {
    library = dlopen("/proc/self/fd/5", {
      winter_provider_receive_owner: { args: [FFIType.i32], returns: FFIType.i32 },
      winter_provider_accept: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      winter_provider_owner_live: { args: [FFIType.i32], returns: FFIType.i32 },
      winter_provider_read_frame: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.cstring },
      winter_provider_write_frame: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      winter_provider_close_client: { args: [FFIType.i32], returns: FFIType.void },
    });
    ownerFd = library.symbols.winter_provider_receive_owner(PROVIDER_FDS.admission);
    if (ownerFd < 0) { counter.summary("failure"); return PROVIDER_EXIT.nativeFailure; }
  } catch { return PROVIDER_EXIT.nativeFailure; }
  let stopped = false;
  process.once("SIGTERM", () => { stopped = true; }); process.once("SIGINT", () => { stopped = true; });
  counter.ready();
  void readControl(counter); // C-P11: Root's receipt requests on stdin; EOF is not a stop.
  try {
    while (!stopped && library.symbols.winter_provider_owner_live(ownerFd) === 1) {
      const clientFd = library.symbols.winter_provider_accept(PROVIDER_FDS.listener, ownerFd, metadata.runtimeUid);
      if (clientFd >= 0) {
        try {
          const request = library.symbols.winter_provider_read_frame(clientFd, ownerFd, metadata.runtimeUid);
          const reply = await counter.arrive(request ? request.toString() : null);
          if (reply && library.symbols.winter_provider_write_frame(clientFd, ownerFd, metadata.runtimeUid, ptr(reply)) !== 0) throw new Error("write");
        } finally { library.symbols.winter_provider_close_client(clientFd); }
      }
      await Bun.sleep(0); // native accept is bounded; signals are processed between calls.
    }
    reason = stopped ? "signal" : "owner-gone";
    counter.summary(reason);
    return PROVIDER_EXIT.stopped;
  } catch { counter.summary("failure"); return PROVIDER_EXIT.nativeFailure; }
  finally { try { port.close(); library.close(); } catch {} }
}
async function readControl(counter) {
  try {
    const reader = Bun.stdin.stream().getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) { counter.controlLine(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
      if (buffer.length > 64) { counter.controlLine(buffer); buffer = ""; }
    }
  } catch { /* an unreadable control channel never stops the provider */ }
}
function refusal(error): number {
  // Fixed codes only: nothing from the metadata, the script or any request is ever echoed.
  line(JSON.stringify({ kind: "provider-refused", version: 1, code: error instanceof ProviderStartupRefusal ? error.code : "fixture" }) + "\n");
  return PROVIDER_EXIT.startupRefused;
}

if (import.meta.main) process.exitCode = await main();
