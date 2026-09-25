// THE PROVIDER-STATE SIDECAR'S ONE READER (WS-05 §13, WS-18 W18-14/W18-20), and the label a retired
// handoff note carries.
//
// WS-23: both lived in `materialized-resume.ts`, the official leg's decoration door, which is gone.
// Two readers survive it — `reviewSwitch` (`review-switch.ts`), which reads the sidecar's origin
// records to find the live model, and the run-home exit reconcile (`run-home/exit.ts`), which reads the
// sidecar to recompute a claude-ready copy and recognises a staged handoff note by its label. Moved
// here verbatim, so nothing either of them reads changed.
import { readFileSync } from "node:fs";
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
 * Reads and parses the provider-state sidecar into `ProviderStateRecord[]`. A torn tail line is
 * skipped, never fatal — the sidecar's own write-ahead posture means a partial line is a crash
 * artefact, not a corruption. An absent sidecar (no session, or one that never carried opaque state)
 * reads as `[]`.
 *
 * NEVER LOGGED, and `payload` is never inspected beyond passing it through opaque (WS-05 §13's global
 * rule): this function parses the ENVELOPE only.
 */
export async function readProviderStateSidecar(winterHome: string, key: SessionKey): Promise<ProviderStateRecord[]> {
  let raw: string;
  try {
    raw = readFileSync(providerStateSidecarPath(winterHome, key), "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  const records: ProviderStateRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as ProviderStateRecord);
    } catch {
      /* a torn tail: skipped, never fatal (this sidecar's own write-ahead posture) */
    }
  }
  return records;
}
