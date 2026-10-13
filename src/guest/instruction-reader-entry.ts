/** Compiled-role entry only. Importing this module never consumes stdin or starts a reader. */
import { readSync, writeSync } from "node:fs";
import { readerRoleMatches, runInstructionReaderTransport } from "./instruction-reader-transport.ts";

async function main(): Promise<number> {
  try {
    // These are refusal tripwires, not a native admission. Root must attest the actual launched
    // executable/view/UID/owner/lifetime externally. No token or capability is created here.
    if (process.platform !== "linux" || !readerRoleMatches({ platform: process.platform, pid: process.pid,
      uid: process.getuid?.() ?? -1, euid: process.geteuid?.() ?? -1, gid: process.getgid?.() ?? -1, egid: process.getegid?.() ?? -1,
      executable: process.execPath, args: process.argv.slice(2), cwd: process.cwd(), env: { ...process.env } })) throw new Error("reader role unavailable");
    await runInstructionReaderTransport({
      read(maximum) { const buffer = Buffer.alloc(maximum); const count = readSync(0, buffer, 0, maximum, null); return count === 0 ? null : buffer.subarray(0, count); },
      write(bytes) { return writeSync(1, bytes); },
    });
    return 0;
  } catch {
    // Never serialize the error, request, environment, config, guidance or path into stderr.
    const bytes = Buffer.from("instruction_reader_unavailable\n"); let at = 0, retries = 0;
    while (at < bytes.byteLength) {
      try { const count = writeSync(2, bytes.subarray(at)); if (count < 1) break; at += count; }
      catch (error) { if ((error as { code?: unknown })?.code === "EINTR" && ++retries <= 32) continue; break; }
    }
    return 64;
  }
}
if (import.meta.main) process.exitCode = await main();
