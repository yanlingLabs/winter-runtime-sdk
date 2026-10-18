// @ts-nocheck -- thin runner. Its relative imports resolve only inside the staged guided packet
// (source/builder/... beside source/sdk/... and source/winter/...); the repository typecheck must not follow them.
/** Guided hostClient, driven by Root's stdin commands (C-H4, C-H9). The actual SDK `query` over Root-owned pipes, with Winter Core's guided reader adapter (which wraps the
 * current-context planner, the resolver and the structured-instruction mapper) answering the runtime-context callback from
 * the guided reader frame. It claims the SDK's one guest issuer, so this module is the ONLY holder of that claim in the
 * process. Contract C-H1..C-H12 is in scripts/guest-guided-build/README.md; every ordering decision lives in
 * host-client-core.ts and is tested there with fakes. It has no network client, no child process and no dynamic import. */
import { closeSync, fstatSync, readFileSync, writeSync, createReadStream } from "node:fs";
import { query, prepareGuidedQuery, consumeGuidedQueryCorrelation, closeGuidedQuery, claimGuidedGuestIssuer } from "@yanlinglabs/winter-agent-sdk";
import { readGuidedQueryInstructions } from "../../../../sdk/packages/sdk/src/guided-query-reader.ts";
import { assertLinuxGuidedHostQueryConfig } from "../../../../sdk/packages/runtime/src/guest/linux-guided-host-query-profile.ts";
import { createCoworkGuidedRuntimeContextHandler } from "../../../../winter/packages/core/src/cowork/guided-reader-adapter.ts";
import { CoworkCurrentContextPlanner } from "../../../../winter/packages/core/src/cowork/current-context.ts";
import { CoworkCurrentContextResolver } from "../../../../winter/packages/core/src/cowork/current-context-resolver.ts";
import { mapStructuredCoworkInstructions } from "../../../../winter/packages/core/src/cowork/structured-instruction-mapper.ts";
import { HOST_ARGV, HOST_EXIT, HOST_LIMITS, HostStartupRefusal, checkHostStartup, checkRootFile, checkRootPipe, hostFailureCode, parseHostMetadata, runGuidedHost } from "./host-client-core.ts";

// Keep the three Core classes in the bundle graph as named, reviewed inputs (the glue reaches them through its own imports).
export const hostClientCoreSurface = Object.freeze({ CoworkCurrentContextPlanner, CoworkCurrentContextResolver, mapStructuredCoworkInstructions });

const FDS = Object.freeze({ input: 3, output: 4, error: 5, metadata: 6, lifecycle: 7, cancel: 8 });
const FRAME_CARRY_BYTES = 2 * 1024 * 1024;

function writeAll(fd: number, data: Uint8Array | string): void {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  for (let at = 0; at < bytes.length;) { try { const n = writeSync(fd, bytes, at); if (!n) throw new Error("host pipe closed"); at += n; } catch (error) { if (error?.code !== "EINTR") throw error; } }
}
async function* chunks(fd: number, bound?: number): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const stream = createReadStream("", { fd, autoClose: false, highWaterMark: 65536 });
  let carry = 0;
  try {
    for await (const bytes of stream) {
      const text = decoder.decode(bytes, { stream: true });
      if (bound !== undefined) { const last = text.lastIndexOf("\n"); carry = last < 0 ? carry + Buffer.byteLength(text) : Buffer.byteLength(text.slice(last + 1)); if (carry > bound) throw new Error("host frame bound"); }
      if (text) yield text;
    }
    const tail = decoder.decode(); if (tail) yield tail;
  } finally { stream.destroy(); }
}
/** The runtime process as the SDK sees it: bytes in, bytes out, lifecycle from Root. Transport EOF is not teardown proof. */
function createProcess() {
  let ended = false, killed = false;
  const process = {
    pid: null,
    stdin: { write(chunk) { writeAll(FDS.input, chunk); }, end() { if (!ended) { ended = true; closeSync(FDS.input); } } },
    stdout: chunks(FDS.output, FRAME_CARRY_BYTES),
    stderr: chunks(FDS.error),
    exited: (async () => {
      let wire = "";
      for await (const chunk of chunks(FDS.lifecycle)) { wire += chunk; if (Buffer.byteLength(wire) > 64) throw new Error("host lifecycle bound"); }
      if (!/^HQX1:[0-9]{1,3}\n$/.test(wire)) throw new Error("host lifecycle");
      const code = Number(wire.slice(5).trim()); if (code > 255) throw new Error("host lifecycle");
      return { code, signal: null };
    })(),
    kill() { if (!killed) { killed = true; writeAll(FDS.cancel, "K"); } },
  };
  void process.exited.catch(() => {});
  return process;
}
/** Root's command channel: one line per command on stdin, bounded; an overlong line is returned as an unknown command. */
function createCommandReader() {
  const reader = Bun.stdin.stream().getReader(); const decoder = new TextDecoder("utf-8"); let buffer = "", discarding = false;
  return async (): Promise<string | null> => {
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); if (discarding) { discarding = false; return "oversize"; } return line; }
      if (buffer.length > HOST_LIMITS.commandBytes) { buffer = ""; discarding = true; }
      const { value, done } = await reader.read(); if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
  };
}
function emit(value): void {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > HOST_LIMITS.reportLineBytes) throw new Error("host report bound");
  writeAll(1, line);
}

async function main(): Promise<number> {
  let meta;
  try {
    checkHostStartup(process.platform, process.argv.slice(2));
    if (process.getuid?.() !== 40001) throw new HostStartupRefusal("identity");
    checkRootFile(fstatSync(FDS.metadata), HOST_LIMITS.metadataBytes);
    for (const fd of [FDS.input, FDS.output, FDS.error, FDS.lifecycle, FDS.cancel]) checkRootPipe(fstatSync(fd));
    meta = parseHostMetadata(readFileSync(FDS.metadata));
  } catch (error) {
    emit({ kind: "host-refused", version: 1, code: error instanceof HostStartupRefusal ? error.code : "input" });
    return HOST_EXIT.startupRefused;
  }
  try {
    const result = await runGuidedHost(meta, {
      sdk: { query, prepareGuidedQuery, consumeGuidedQueryCorrelation, closeGuidedQuery, claimGuidedGuestIssuer },
      readInstructions: readGuidedQueryInstructions, createHandler: createCoworkGuidedRuntimeContextHandler,
      assertConfig: assertLinuxGuidedHostQueryConfig, createProcess, emit, nextCommand: createCommandReader(),
    });
    return result.passed ? HOST_EXIT.passed : HOST_EXIT.runFailed;
  } catch (error) {
    emit({ kind: "host-result", version: 1, passed: false, failure: { code: hostFailureCode(error) } });
    return HOST_EXIT.runFailed;
  }
}

if (import.meta.main) process.exitCode = await main();
