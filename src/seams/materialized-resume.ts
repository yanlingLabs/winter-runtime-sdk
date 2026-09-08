// WS-13 §8.2: THE MATERIALIZED-RESUME DOORS. Lane C implements them in `src/store/**`.
//
// TWO DOORS, and which one is open is a MEASURED fact, not a preference:
//   * FALLBACK — one labelled handoff entry appended at the barrier. Always available.
//   * PREFERRED — the decorations are baked into the MATERIALIZED RESUME COPY, leaving the canonical
//     file byte-pure. Permitted only once all four of WS-17 §8's probes pass: (a) neighbour-file
//     survival, (b) no wash-back into the canonical file, (c) a sidecar-present round-trip, (d) crash
//     pairs. Any probe failing keeps the door shut and the reason recorded.
//
// The pinned evidence this must not disturb (WS-13 §8.2): "Claude Code replays every uncompacted
// historical thinking/redacted block on every later request, sends `clear_thinking_20251015
// keep:\"all\"`, and restores opaque blocks across an Agent SDK fresh-process resume." Opaque
// provider state is never logged and never written into a model-readable file.
import type { SessionKey } from "@yanlinglabs/winter-agent-sdk";

import type { RuntimeKind } from "../selection/runtime-selection.ts";

export type MaterializedResumeDoor = "preferred" | "fallback";

/** The four probes that gate PREFERRED (WS-17 §8's row-129 narrative). */
export type MaterializedResumeProbeId = "neighbor-file-survival" | "no-wash-back" | "sidecar-round-trip" | "crash-pairs";

export interface MaterializedResumeProbeResult {
  probe: MaterializedResumeProbeId;
  passed: boolean;
  /** What was observed — recorded whether it passed or not, so "enabled" is always attributable. */
  evidence: string;
}

export interface MaterializedResumeProbeReport {
  /** PREFERRED is open only when every probe passed. */
  door: MaterializedResumeDoor;
  results: MaterializedResumeProbeResult[];
  /** ISO-8601. */
  probedAt: string;
}

export interface MaterializedResumeInput {
  session: SessionKey;
  /** The runtime the resumed generation will run on — it decides what a decoration may say. */
  to: RuntimeKind;
  /** Path of the materialized copy the destination runtime will read. */
  materializedPath: string;
  /** The handoff note the destination's first generation should see. */
  decoration: { kind: "handoff"; from: RuntimeKind; at: string; text: string };
}

export interface MaterializedResumeResult {
  door: MaterializedResumeDoor;
  /** The file the destination runtime is pointed at (the materialized copy under PREFERRED). */
  resumePath: string;
  /** True when the canonical transcript was NOT written to — the property PREFERRED exists for. */
  canonicalUntouched: boolean;
}

/** WS-13 §8.2's decoration doors. Lane C implements; the spine pins the signature. */
export interface MaterializedResumeDecorator {
  /** Which door is currently open, per the last probe run. */
  readonly door: MaterializedResumeDoor;
  probe(): Promise<MaterializedResumeProbeReport>;
  decorate(input: MaterializedResumeInput): Promise<MaterializedResumeResult>;
}
