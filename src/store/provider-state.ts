// THE PROVIDER-STATE SIDECAR'S ONE READER (WS-05 §13, WS-18 W18-14/W18-20), and the label a retired
// handoff note carries.
//
// WS-23: both lived in `materialized-resume.ts`, the official leg's decoration door, which is gone.
// Two readers survive it — `reviewSwitch` (`review-switch.ts`), which reads the sidecar's origin
// records to find the live model, and the run-home exit reconcile (`run-home/exit.ts`), which reads the
// sidecar to recompute a claude-ready copy and recognises a staged handoff note by its label. Moved
// here verbatim, so nothing either of them reads changed.
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import type { SessionKey } from "@yanlinglabs/winter-agent-sdk";
import type { ProviderStateRecord } from "@yanlinglabs/winter-provider-runtime";

/** The provider-state sidecar's suffix (WS-05 §13). */
export const PROVIDER_STATE_SUFFIX = ".provider-state.jsonl";

/**
 * The label every barrier-injected entry carried, so it could never read as an ordinary message. No
 * handoff writes one any more (WS-23); an upgrading home's transcripts can still hold one, and the
 * recovery reconcile still has to recognise it.
 */
export const HANDOFF_ENTRY_LABEL = "handoff";

/** The sidecar's path for `key` — WS-05 §13's own naming, never renamed, never a different suffix. */
export function providerStateSidecarPath(winterHome: string, key: SessionKey): string {
  return join(winterHome, "projects", key.projectKey, `${key.sessionId}${PROVIDER_STATE_SUFFIX}`);
}

/**
 * The most record bytes one read KEEPS -- the SDK's own `PROVIDER_STATE_MAX_READ_BYTES`
 * (`packages/runtime/src/store/provider-state.ts`, WS-23 review r1 I-4), mirrored rather than imported
 * because the SDK does not export its reader. A sidecar is a few small records per assistant entry, so
 * this is orders of magnitude above any ordinary session; the bound exists because a file grown without
 * limit (a very long session, a corrupt or attacker-grown file) must not be read into memory without
 * limit on a switch review or a recovery reconcile.
 */
export const PROVIDER_STATE_MAX_READ_BYTES = 64 * 1024 * 1024;

/** One line longer than this is not a record Winter wrote; it is skipped unread (the SDK's own bound). */
export const PROVIDER_STATE_MAX_LINE_BYTES = 16 * 1024 * 1024;

const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Reads and parses the provider-state sidecar into `ProviderStateRecord[]`. A torn tail line is
 * skipped, never fatal — the sidecar's own write-ahead posture means a partial line is a crash
 * artefact, not a corruption. An absent sidecar (no session, or one that never carried opaque state)
 * reads as `[]`.
 *
 * BOUNDED MEMORY, the SDK's streamed read (WS-23): the file is read in 1 MiB chunks, a line past
 * `PROVIDER_STATE_MAX_LINE_BYTES` is dropped without being buffered, and the records RETAINED never
 * exceed `PROVIDER_STATE_MAX_READ_BYTES` -- the OLDEST are let go as the read goes (and cut out of the
 * working list once they pass half of it), so memory tracks the bound, never the file. Keeping the
 * newest is what both readers want: `reviewSwitch` looks for the LIVE model (the latest origin record),
 * and the recovery reconcile's record-for-record recompute can only fail to match with records missing,
 * which excludes that transcript rather than washing an unproved line into the canonical file.
 * `limits` exists for tests.
 *
 * NEVER LOGGED, and `payload` is never inspected beyond passing it through opaque (WS-05 §13's global
 * rule): this function parses the ENVELOPE only.
 */
export async function readProviderStateSidecar(
  winterHome: string,
  key: SessionKey,
  limits: { maxKeptBytes?: number; maxLineBytes?: number; stats?: { peakRetained: number } } = {},
): Promise<ProviderStateRecord[]> {
  const maxKept = limits.maxKeptBytes ?? PROVIDER_STATE_MAX_READ_BYTES;
  const maxLine = limits.maxLineBytes ?? PROVIDER_STATE_MAX_LINE_BYTES;
  let fd: number;
  try {
    fd = openSync(providerStateSidecarPath(winterHome, key), "r");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  const kept: Array<{ record: ProviderStateRecord; bytes: number }> = [];
  let head = 0;
  let keptBytes = 0;
  const keep = (line: Buffer): void => {
    const text = line.toString("utf8");
    if (text.trim().length === 0) return;
    let record: ProviderStateRecord;
    try {
      record = JSON.parse(text) as ProviderStateRecord;
    } catch {
      return; /* a torn tail: skipped, never fatal (this sidecar's own write-ahead posture) */
    }
    kept.push({ record, bytes: line.length });
    keptBytes += line.length;
    while (keptBytes > maxKept && head < kept.length) {
      keptBytes -= kept[head]!.bytes;
      head++;
    }
    if (head > 0 && head * 2 >= kept.length) {
      kept.splice(0, head);
      head = 0;
    }
    if (limits.stats !== undefined && kept.length > limits.stats.peakRetained) limits.stats.peakRetained = kept.length;
  };
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, from);
        if (nl === -1 || nl >= n) break;
        if (!skipping) keep(Buffer.concat([...pending, chunk.subarray(from, nl)]));
        pending = [];
        pendingBytes = 0;
        skipping = false;
        from = nl + 1;
      }
      if (from < n && !skipping) {
        pendingBytes += n - from;
        if (pendingBytes > maxLine) {
          // An oversized line: dropped whole, without buffering the rest of it.
          skipping = true;
          pending = [];
          pendingBytes = 0;
        } else pending.push(Buffer.from(chunk.subarray(from, n)));
      }
    }
    if (!skipping && pendingBytes > 0) keep(Buffer.concat(pending));
  } finally {
    closeSync(fd);
  }
  return kept.slice(head).map((entry) => entry.record);
}
