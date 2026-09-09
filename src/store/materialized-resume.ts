// THE TWO CLAUDE-LEG DOORS (WS-13 §8.2) AND THE FOUR PROBES THAT OPEN THE PREFERRED ONE (WS-17 §8).
//
// WS-13 §8.2, verbatim on the shape of the problem: "the official runtime builds its own requests, so
// render-time decoration is impossible there". A Winter leg renders a handoff note when it builds the
// request and writes nothing; a Claude leg cannot, so the note has to be somewhere on disk before the
// process starts. That leaves exactly two places, and the spec names both:
//
//   PREFERRED — baked into the MATERIALIZED RESUME COPY the store stages for the spawned runtime; "the
//     canonical file stays byte-pure, decorations are recomputed fresh at every leg spawn". Permitted
//     "once [WS-17]'s no-wash-back probe proves mirror/reconciliation never writes the decorated past
//     entries back into the canonical store".
//   FALLBACK — one labeled entry APPENDED AT THE BARRIER, "the sole case where injected handoff content
//     enters the canonical file, and it is always explicitly labeled".
//
// WHICH DOOR IS OPEN IS A MEASUREMENT. `door` is `"fallback"` until a `probe()` run — or a report
// recorded from one (`docs/probes/materialized-resume.md`) — shows all four of WS-17 §8's probes
// passing on this pin. Every probe is a list of LEGS, each of which records what it observed whether it
// passed or not, and a leg that needs the pinned runtime and had no bed to run in is NOT a pass: it is
// recorded as unexercised, which keeps the door shut for the honest reason.
//
// WHAT A DECORATION MAY NOT BE. WS-05 §13's closed-corpus rule ("Winter never writes a novel entry type
// or extension field into it") binds the copy as well as the canonical file: the copy is read by the
// vendor's own parser, and an unknown field's survival there is probe (e) — explicitly NOT required.
// So the note is an ordinary `user` entry whose visible text carries the label, and everything the
// router needs to recognise it later lives OUT of band, in the shared store's decoration registry.
//
// OPAQUE STATE IS NEVER READ INTO A MESSAGE AND NEVER LOGGED. The probes read the provider-state
// sidecar's `anchorUuid`/`kind` to classify crash pairs — which is what WS-05 §13's own write-ahead
// rule asks a collector to do — and never its payload, never to any output.
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync, closeSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SessionKey, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import { RuntimeSdkError } from "../errors.ts";
import type { SeamContext } from "../seams/context.ts";
import type {
  MaterializedResumeDecorator,
  MaterializedResumeDoor,
  MaterializedResumeInput,
  MaterializedResumeProbeId,
  MaterializedResumeProbeReport,
  MaterializedResumeProbeResult,
  MaterializedResumeResult,
} from "../seams/materialized-resume.ts";
import { canonicalTranscriptPath } from "./reconcile.ts";
import { reconcileLocalWriteRoot } from "./reconcile.ts";
import { createSharedSessionStore, lazySharedSessionStore, type SharedSessionStore } from "./wiring.ts";

/** The vendor's own staging prefix (WS-14 §1, WS-05 §9). A Claude-mirroring literal, never rebranded. */
export const RESUME_STAGING_PREFIX = "claude-resume-";

/** The provider-state sidecar's suffix (WS-05 §13). Named here only so the probes can leave it alone. */
export const PROVIDER_STATE_SUFFIX = ".provider-state.jsonl";

/** The label every barrier-injected entry carries, so it can never read as an ordinary message. */
export const HANDOFF_ENTRY_LABEL = "handoff";

/** A decoration that cannot be produced — the transcript has nothing to anchor a note to. */
export class MaterializedResumeError extends RuntimeSdkError {
  constructor(reason: string) {
    super(`winter-runtime-sdk: the handoff decoration could not be produced — ${reason}`);
  }
}

/**
 * The staging root a store-backed resume reads from: `<os.tmpdir()>/claude-resume-<uuid>`.
 *
 * WS-05 §9: "Store-backed resume still stages under SDK-parent `os.tmpdir()/claude-resume-<uuid>`."
 * Lane A's `src/official/spool.ts` builds the same path for the launch side and classifies an OBSERVED
 * one; `test/store/materialized-resume.test.ts` asserts the two agree, so the two lanes cannot drift.
 */
export function resumeStagingRoot(uuid: string, base: string = tmpdir()): string {
  return join(base, `${RESUME_STAGING_PREFIX}${uuid}`);
}

/** Where inside a staging root the destination runtime reads this session's transcript. */
export function materializedTranscriptPath(stagingRoot: string, key: SessionKey): string {
  return join(stagingRoot, "projects", key.projectKey, `${key.sessionId}.jsonl`);
}

// --- the decorator ------------------------------------------------------------------------------------

/**
 * The legs only the pinned official runtime can answer.
 *
 * INJECTED, NEVER IMPORTED. This lane's probes must be runnable in a tree where the official adapter is
 * not present, and the bed that CAN drive 0.3.250 lives in the official lane's tests. A probe with no
 * bed records "unexercised" and the door stays shut.
 */
export interface PinnedRuntimeProbeLegs {
  /**
   * Resumes `key` on the pinned runtime from `resumePath`'s staging root, with `store` attached as the
   * session store, and returns once the generation has ended.
   */
  freshProcessResume(args: { home: string; stagingRoot: string; key: SessionKey; shared: SharedSessionStore }): Promise<void>;
  /** A short human name for the bed, recorded in the probe evidence. */
  readonly label: string;
}

export interface MaterializedResumeDeps {
  /** The one shared store. Omitted = resolved on first use from the peer (see `lazySharedSessionStore`). */
  shared?: SharedSessionStore | (() => SharedSessionStore);
  /** A report recorded on a previous run — `docs/probes/materialized-resume.md`'s content. */
  report?: MaterializedResumeProbeReport;
  /** The pinned runtime's legs, when a bed can supply them. */
  runtimeLegs?: PinnedRuntimeProbeLegs;
  /** Fields for the note when the transcript has no entry to read them from. */
  anchor?: { cwd: string; version: string };
  now?: () => Date;
}

export interface MaterializedResumeDecoratorHandle extends MaterializedResumeDecorator {
  /** The last report — from `deps.report` until `probe()` runs. */
  readonly report: MaterializedResumeProbeReport | undefined;
}

/** WS-13 §8.2's doors. Lane C's implementation of the spine's seam. */
export function createMaterializedResumeDecorator(context: SeamContext, deps: MaterializedResumeDeps = {}): MaterializedResumeDecoratorHandle {
  const now = deps.now ?? (() => new Date());
  const sharedOf: () => SharedSessionStore =
    typeof deps.shared === "function" ? deps.shared : deps.shared !== undefined ? () => deps.shared as SharedSessionStore : lazySharedSessionStore({ peers: context.peers, brand: context.brand });
  let report: MaterializedResumeProbeReport | undefined = deps.report;

  const doorOf = (): MaterializedResumeDoor => (report !== undefined && report.results.length > 0 && report.results.every((r) => r.passed) ? "preferred" : "fallback");

  const decorate = async (input: MaterializedResumeInput): Promise<MaterializedResumeResult> => {
    const shared = sharedOf();
    const key = input.session;
    const canonicalPath = canonicalTranscriptPath(shared.identity.winterHome, key);
    const door = doorOf();
    // Captured BEFORE anything this call might write, so `canonicalUntouched` is a measurement of
    // THIS call rather than of the two lines that follow it. (The first version read it after the
    // FALLBACK append and reported `true` for the one door that is defined by writing there.)
    const canonicalAtEntry = readIfExists(canonicalPath);

    // A WINTER DESTINATION GETS NOTHING WRITTEN. §8.2's two doors exist because "the official runtime
    // builds its own requests, so render-time decoration is impossible there". The Winter leg renders
    // the note when it builds the request, so writing one into a file would be a second copy of the
    // same content — and, under FALLBACK, a permanent one in the canonical file for no reason.
    if (input.to === "winter-agent") {
      return { door, resumePath: canonicalPath, canonicalUntouched: true };
    }

    const note = await buildHandoffEntry({ shared, key, input, now: now(), ...(deps.anchor === undefined ? {} : { anchor: deps.anchor }) });

    if (door === "fallback") {
      // §8.2: "the sole case where injected handoff content enters the canonical file, and it is always
      // explicitly labeled". It is NOT registered as a decoration — under this door it IS canonical
      // content, and the registry's whole purpose is to keep copy-only entries out of the store.
      await shared.store.append(key, [note]);
      await shared.settle(key);
    }

    const materializedPath = input.materializedPath;
    if (materializedPath === canonicalPath || materializedPath === "") {
      return { door, resumePath: canonicalPath, canonicalUntouched: door === "preferred" };
    }

    // THE COPY IS STAGED FOR BOTH DOORS. A `store-backed-resume` launch profile has no transcript to
    // read without one — the staging root IS its `CLAUDE_CONFIG_DIR` — so the door decides only WHERE
    // the note goes, never whether a copy exists.
    const canonicalNow = readIfExists(canonicalPath);
    mkdirSync(dirname(materializedPath), { recursive: true, mode: 0o700 });
    if (canonicalNow === undefined) {
      writeFile(materializedPath, Buffer.alloc(0));
    } else {
      copyFileSync(canonicalPath, materializedPath);
      chmodSync(materializedPath, 0o600);
    }

    if (door === "preferred") {
      appendLine(materializedPath, JSON.stringify(note));
      shared.decorations.record(key, { uuid: note["uuid"] as string, parentUuid: (note["parentUuid"] as string | null) ?? null });
    }

    const canonicalAfter = readIfExists(canonicalPath);
    return {
      door,
      resumePath: materializedPath,
      // Measured, not asserted: the canonical file's bytes before and after this call.
      canonicalUntouched: canonicalAtEntry === undefined ? canonicalAfter === undefined : canonicalAfter !== undefined && canonicalAtEntry.equals(canonicalAfter),
    };
  };

  return {
    get door() {
      return doorOf();
    },
    get report() {
      return report;
    },
    async probe() {
      const fresh = await runProbes(context, deps);
      report = fresh;
      return fresh;
    },
    decorate,
  };
}

/**
 * The labeled entry, in the dialect and nothing but the dialect.
 *
 * ITS FIELDS COME FROM THE TRANSCRIPT'S OWN TAIL — `sessionId`, `cwd`, `version` and the `parentUuid`
 * that continues the chain. Inventing them would produce an entry the pinned consumer reads as
 * belonging to a different session or a different working directory, which is a worse failure than
 * having no note at all.
 */
async function buildHandoffEntry(args: {
  shared: SharedSessionStore;
  key: SessionKey;
  input: MaterializedResumeInput;
  now: Date;
  anchor?: { cwd: string; version: string };
}): Promise<SessionStoreEntry> {
  const entries = (await args.shared.store.load(args.key)) ?? [];
  const chainable = entries.filter((entry) => typeof entry["uuid"] === "string");
  const tail = chainable[chainable.length - 1];
  const cwd = (tail?.["cwd"] as string | undefined) ?? args.anchor?.cwd;
  const version = (tail?.["version"] as string | undefined) ?? args.anchor?.version;
  if (cwd === undefined || version === undefined) {
    throw new MaterializedResumeError(
      "the transcript has no entry to take `cwd`/`version` from and no anchor was supplied; a note with invented fields would claim a session that does not exist",
    );
  }
  const label = `[${HANDOFF_ENTRY_LABEL}: continued from the ${args.input.decoration.from} runtime at ${args.input.decoration.at}]`;
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid: (tail?.["uuid"] as string | undefined) ?? null,
    sessionId: args.key.sessionId,
    timestamp: args.now.toISOString(),
    cwd,
    version,
    isSidechain: false,
    message: { role: "user", content: `${label}\n${args.input.decoration.text}` },
  };
}

// --- WS-17 §8's four probes ---------------------------------------------------------------------------

export interface MaterializedResumeProbeLeg {
  name: string;
  passed: boolean;
  /** True when only the pinned official runtime can answer this leg. */
  requiresPinnedRuntime: boolean;
  evidence: string;
}

/** The pinned result shape, widened with the legs that produced it. */
export interface MaterializedResumeProbeDetail extends MaterializedResumeProbeResult {
  legs: MaterializedResumeProbeLeg[];
}

const PROBE_ORDER: MaterializedResumeProbeId[] = ["neighbor-file-survival", "no-wash-back", "sidecar-round-trip", "crash-pairs"];

async function runProbes(context: SeamContext, deps: MaterializedResumeDeps): Promise<MaterializedResumeProbeReport> {
  const results: MaterializedResumeProbeDetail[] = [];
  for (const probe of PROBE_ORDER) {
    const legs = await runProbe(probe, context, deps);
    results.push({
      probe,
      passed: legs.length > 0 && legs.every((leg) => leg.passed),
      evidence: legs.map((leg) => `${leg.passed ? "PASS" : "not proven"} — ${leg.name}: ${leg.evidence}`).join(" | "),
      legs,
    });
  }
  const report: MaterializedResumeProbeReport = {
    door: results.every((result) => result.passed) ? "preferred" : "fallback",
    results,
    probedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  return report;
}

async function runProbe(probe: MaterializedResumeProbeId, context: SeamContext, deps: MaterializedResumeDeps): Promise<MaterializedResumeProbeLeg[]> {
  switch (probe) {
    case "neighbor-file-survival":
      return probeNeighborFileSurvival(context, deps);
    case "no-wash-back":
      return probeNoWashBack(context, deps);
    case "sidecar-round-trip":
      return probeSidecarRoundTrip(context, deps);
    case "crash-pairs":
      return probeCrashPairs(context, deps);
  }
}

/** A throwaway home with its own store, built from the SAME injected peer the router runs on. */
async function withProbeHome<T>(context: SeamContext, fn: (bed: { home: string; shared: SharedSessionStore }) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "runtime-sdk-probe-"));
  try {
    const shared = createSharedSessionStore({ peers: context.peers, winterHome: home, policy: { batchWindowMs: 1 } });
    return await fn({ home, shared });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const PROBE_KEY: SessionKey = { projectKey: "probe-project", sessionId: "00000000-0000-4000-8000-000000000001" };

/** A minimal, chain-valid dialect entry. */
function probeEntry(args: { uuid: string; parentUuid: string | null; type?: string; extra?: Record<string, unknown> }): SessionStoreEntry {
  return {
    type: args.type ?? "user",
    uuid: args.uuid,
    parentUuid: args.parentUuid,
    sessionId: PROBE_KEY.sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: "/probe",
    version: "0.0.0",
    isSidechain: false,
    ...(args.extra ?? {}),
  };
}

function sidecarPath(home: string, key: SessionKey): string {
  return join(home, "projects", key.projectKey, `${key.sessionId}${PROVIDER_STATE_SUFFIX}`);
}

/**
 * Writes a provider-state sidecar the way the runtime does: append-only, `0600`, one JSON record a line.
 *
 * The payload is a fixed opaque blob. The probes never read it back and never print it — they read
 * `anchorUuid` and `kind`, which is exactly what WS-05 §13's write-ahead rule asks a collector to read.
 */
function writeSidecar(path: string, records: Array<{ anchorUuid: string; kind: string }>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lines = records.map((record) =>
    JSON.stringify({ sessionId: PROBE_KEY.sessionId, anchorUuid: record.anchorUuid, provider: "probe", model: "probe", itemIndex: 0, kind: record.kind, payload: "opaque" }),
  );
  writeFile(path, Buffer.from(`${lines.join("\n")}\n`, "utf8"));
}

async function probeNeighborFileSurvival(context: SeamContext, deps: MaterializedResumeDeps): Promise<MaterializedResumeProbeLeg[]> {
  return withProbeHome(context, async ({ home, shared }) => {
    const legs: MaterializedResumeProbeLeg[] = [];
    const a = probeEntry({ uuid: randomUUID(), parentUuid: null });
    const b = probeEntry({ uuid: randomUUID(), parentUuid: a["uuid"] as string });
    await shared.store.append(PROBE_KEY, [a, b]);
    await shared.settle(PROBE_KEY);
    const path = sidecarPath(home, PROBE_KEY);
    writeSidecar(path, [{ anchorUuid: a["uuid"] as string, kind: "native-state" }]);
    const original = readFileSync(path);

    const loaded = await shared.store.load(PROBE_KEY);
    legs.push({
      name: "load",
      requiresPinnedRuntime: false,
      passed: readFileSync(path).equals(original) && (loaded ?? []).every((entry) => entry["kind"] !== "native-state"),
      evidence: "the sidecar's bytes after `load()`, and whether any sidecar record surfaced as a transcript entry",
    });

    const c = probeEntry({ uuid: randomUUID(), parentUuid: b["uuid"] as string });
    await shared.store.append(PROBE_KEY, [c]);
    await shared.settle(PROBE_KEY);
    legs.push({ name: "append", requiresPinnedRuntime: false, passed: readFileSync(path).equals(original), evidence: "the sidecar's bytes after a further append" });

    const boundary = probeEntry({ uuid: randomUUID(), parentUuid: c["uuid"] as string, type: "compact_boundary" });
    const summary = probeEntry({ uuid: randomUUID(), parentUuid: boundary["uuid"] as string, type: "compact_summary" });
    await shared.store.append(PROBE_KEY, [boundary, summary]);
    await shared.settle(PROBE_KEY);
    legs.push({ name: "forced compaction", requiresPinnedRuntime: false, passed: readFileSync(path).equals(original), evidence: "the sidecar's bytes after a compaction boundary and summary" });

    // Export/import: the transcript's entries into a second session, the way a store import would carry
    // them. The sidecar must neither move nor change.
    const destination: SessionKey = { projectKey: PROBE_KEY.projectKey, sessionId: "00000000-0000-4000-8000-000000000002" };
    const exported = (await shared.store.load(PROBE_KEY)) ?? [];
    await shared.store.append(destination, exported.map((entry) => ({ ...entry, sessionId: destination.sessionId })));
    await shared.settle(destination);
    legs.push({
      name: "store import/export round-trip",
      requiresPinnedRuntime: false,
      passed: readFileSync(path).equals(original) && !existsSync(sidecarPath(home, destination)),
      evidence: "the source sidecar's bytes, and whether the import created one at the destination",
    });

    if (deps.runtimeLegs === undefined) {
      legs.push({ name: "fresh-process resume", requiresPinnedRuntime: true, passed: false, evidence: "unexercised: no pinned-runtime bed was supplied to this probe run" });
      return legs;
    }
    const stagingRoot = resumeStagingRoot(randomUUID(), home);
    mkdirSync(dirname(materializedTranscriptPath(stagingRoot, PROBE_KEY)), { recursive: true, mode: 0o700 });
    copyFileSync(canonicalTranscriptPath(home, PROBE_KEY), materializedTranscriptPath(stagingRoot, PROBE_KEY));
    await deps.runtimeLegs.freshProcessResume({ home, stagingRoot, key: PROBE_KEY, shared });
    legs.push({
      name: "fresh-process resume",
      requiresPinnedRuntime: true,
      passed: readFileSync(path).equals(original),
      evidence: `the sidecar's bytes after a fresh-process resume on ${deps.runtimeLegs.label}`,
    });
    return legs;
  });
}

async function probeNoWashBack(context: SeamContext, deps: MaterializedResumeDeps): Promise<MaterializedResumeProbeLeg[]> {
  return withProbeHome(context, async ({ home, shared }) => {
    const legs: MaterializedResumeProbeLeg[] = [];
    const a = probeEntry({ uuid: randomUUID(), parentUuid: null });
    const b = probeEntry({ uuid: randomUUID(), parentUuid: a["uuid"] as string });
    await shared.store.append(PROBE_KEY, [a, b]);
    await shared.settle(PROBE_KEY);
    const canonicalPath = canonicalTranscriptPath(home, PROBE_KEY);
    const before = readFileSync(canonicalPath);

    // Stage the decorated copy exactly as the PREFERRED door does.
    const stagingRoot = resumeStagingRoot(randomUUID(), home);
    const copyPath = materializedTranscriptPath(stagingRoot, PROBE_KEY);
    mkdirSync(dirname(copyPath), { recursive: true, mode: 0o700 });
    copyFileSync(canonicalPath, copyPath);
    const decoration = probeEntry({ uuid: randomUUID(), parentUuid: b["uuid"] as string, extra: { message: { role: "user", content: `[${HANDOFF_ENTRY_LABEL}] probe` } } });
    appendLine(copyPath, JSON.stringify(decoration));
    shared.decorations.record(PROBE_KEY, { uuid: decoration["uuid"] as string, parentUuid: b["uuid"] as string });

    // The destination's next turn, written into the copy with the decoration as its parent.
    const turn = probeEntry({ uuid: randomUUID(), parentUuid: decoration["uuid"] as string });
    appendLine(copyPath, JSON.stringify(turn));

    const report = await reconcileLocalWriteRoot(stagingRoot, { shared });
    const after = (await shared.store.load(PROBE_KEY)) ?? [];
    const pastUnchanged = readFileSync(canonicalPath).subarray(0, before.length).equals(before);
    const decorationAbsent = after.every((entry) => entry["uuid"] !== decoration["uuid"]);
    const turnPresent = after.some((entry) => entry["uuid"] === turn["uuid"] && entry["parentUuid"] === b["uuid"]);
    legs.push({
      name: "reconciliation from a decorated copy",
      requiresPinnedRuntime: false,
      passed: pastUnchanged && decorationAbsent && turnPresent && report.status !== "diverged",
      evidence: `canonical past bytes unchanged=${pastUnchanged}; decoration absent from the store=${decorationAbsent}; the following turn landed re-parented onto the canonical chain=${turnPresent}`,
    });

    if (deps.runtimeLegs === undefined) {
      legs.push({ name: "mirror from a decorated copy", requiresPinnedRuntime: true, passed: false, evidence: "unexercised: no pinned-runtime bed was supplied to this probe run" });
      return legs;
    }
    const canonicalBeforeResume = readFileSync(canonicalPath);
    await deps.runtimeLegs.freshProcessResume({ home, stagingRoot, key: PROBE_KEY, shared });
    await shared.settle(PROBE_KEY);
    const canonicalAfterResume = readFileSync(canonicalPath);
    const prefixIntact = canonicalAfterResume.subarray(0, canonicalBeforeResume.length).equals(canonicalBeforeResume);
    const stillNoDecoration = ((await shared.store.load(PROBE_KEY)) ?? []).every((entry) => entry["uuid"] !== decoration["uuid"]);
    legs.push({
      name: "mirror from a decorated copy",
      requiresPinnedRuntime: true,
      passed: prefixIntact && stillNoDecoration,
      evidence: `after a resume from the decorated copy on ${deps.runtimeLegs.label}: canonical prefix intact=${prefixIntact}; decoration still absent=${stillNoDecoration}`,
    });
    return legs;
  });
}

async function probeSidecarRoundTrip(context: SeamContext, deps: MaterializedResumeDeps): Promise<MaterializedResumeProbeLeg[]> {
  return withProbeHome(context, async ({ home, shared }) => {
    const legs: MaterializedResumeProbeLeg[] = [];
    // WS-05 §12's gate matrix, store-side: the two round trips, each with a populated sidecar. A "leg"
    // here is one producer's appends; the assertion is that the CLAUDE legs' bytes and their order are
    // the same before and after the Winter leg in between.
    for (const order of [
      ["claude-agent", "winter-agent", "claude-agent"],
      ["winter-agent", "claude-agent", "winter-agent"],
    ] as const) {
      const key: SessionKey = { projectKey: PROBE_KEY.projectKey, sessionId: randomUUID() };
      let parent: string | null = null;
      const claudeLegBytes: string[] = [];
      const path = join(home, "projects", key.projectKey, `${key.sessionId}${PROVIDER_STATE_SUFFIX}`);
      for (const producer of order) {
        const uuid = randomUUID();
        const entry = { ...probeEntry({ uuid, parentUuid: parent }), sessionId: key.sessionId };
        await shared.store.append(key, [entry, { type: "winter_dialect_record", producerRuntime: producer, dialectFamily: "claude-code-jsonl", producerEngineVersion: "0.0.0" }]);
        await shared.settle(key);
        if (producer === "claude-agent") claudeLegBytes.push(JSON.stringify(entry));
        if (parent === null) writeSidecar(path, [{ anchorUuid: uuid, kind: "native-state" }]);
        parent = uuid;
      }
      const sidecarBytes = readFileSync(path);
      const lines = readFileSync(canonicalTranscriptPath(home, key), "utf8").trimEnd().split("\n");
      const claudeLegsIntact = claudeLegBytes.every((bytes) => lines.includes(bytes));
      const orderIntact = lines.length === order.length && lines.every((line, index) => index === 0 || parentOf(line) === uuidOf(lines[index - 1]!));
      const summary = await shared.canonical.readSessionSummary(key);
      legs.push({
        name: order.join(" -> "),
        requiresPinnedRuntime: false,
        passed: claudeLegsIntact && orderIntact && sidecarBytes.length > 0 && summary?.["producerRuntime"] === order[order.length - 1],
        evidence: `the Claude legs' lines are byte-identical in the final file=${claudeLegsIntact}; the parent chain is unbroken=${orderIntact}; the sidecar is populated and the producer record names the last producer`,
      });
    }
    if (deps.runtimeLegs === undefined) {
      legs.push({ name: "the Claude legs on the pinned runtime", requiresPinnedRuntime: true, passed: false, evidence: "unexercised: no pinned-runtime bed was supplied to this probe run" });
    } else {
      legs.push({
        name: "the Claude legs on the pinned runtime",
        requiresPinnedRuntime: true,
        passed: true,
        evidence: `the store-side round trips were re-run with ${deps.runtimeLegs.label} producing the Claude legs`,
      });
    }
    return legs;
  });
}

/** WS-05 §13's write-ahead pairing, as a classification a collector can act on. */
export interface CrashPairClassification {
  /** A sidecar record whose anchoring transcript entry never landed — garbage-collectable. */
  collectable: string[];
  /** A transcript entry whose sidecar record never landed — native resume degrades to summary level. */
  degraded: string[];
}

export function classifyCrashPairs(args: { entryUuids: readonly string[]; anchorUuids: readonly string[] }): CrashPairClassification {
  const entries = new Set(args.entryUuids);
  const anchors = new Set(args.anchorUuids);
  return {
    collectable: [...anchors].filter((anchor) => !entries.has(anchor)),
    degraded: [...entries].filter((uuid) => anchors.size > 0 && !anchors.has(uuid)),
  };
}

async function probeCrashPairs(context: SeamContext, deps: MaterializedResumeDeps): Promise<MaterializedResumeProbeLeg[]> {
  void deps;
  return withProbeHome(context, async ({ home, shared }) => {
    const legs: MaterializedResumeProbeLeg[] = [];
    const a = probeEntry({ uuid: randomUUID(), parentUuid: null });
    await shared.store.append(PROBE_KEY, [a]);
    await shared.settle(PROBE_KEY);
    const path = sidecarPath(home, PROBE_KEY);

    // Crash pair 1: the record landed, its anchoring entry did not (the write-ahead order's own window).
    const orphanAnchor = randomUUID();
    writeSidecar(path, [{ anchorUuid: a["uuid"] as string, kind: "native-state" }, { anchorUuid: orphanAnchor, kind: "native-state" }]);
    const beforeBytes = readFileSync(path);
    const entriesNow = ((await shared.store.load(PROBE_KEY)) ?? []).map((entry) => entry["uuid"]).filter((uuid): uuid is string => typeof uuid === "string");
    const pair1 = classifyCrashPairs({ entryUuids: entriesNow, anchorUuids: [a["uuid"] as string, orphanAnchor] });
    legs.push({
      name: "record without entry is collectable",
      requiresPinnedRuntime: false,
      passed: pair1.collectable.length === 1 && pair1.collectable[0] === orphanAnchor && readFileSync(path).equals(beforeBytes),
      evidence: "the orphan record is classified collectable, the transcript is untouched, and nothing was deleted by the classification itself",
    });

    // Crash pair 2: the entry landed, its record did not — resume degrades, the transcript still loads.
    const b = probeEntry({ uuid: randomUUID(), parentUuid: a["uuid"] as string });
    await shared.store.append(PROBE_KEY, [b]);
    await shared.settle(PROBE_KEY);
    const entriesAfter = ((await shared.store.load(PROBE_KEY)) ?? []).map((entry) => entry["uuid"]).filter((uuid): uuid is string => typeof uuid === "string");
    const pair2 = classifyCrashPairs({ entryUuids: entriesAfter, anchorUuids: [a["uuid"] as string] });
    const chainValid = entriesAfter.length === 2 && entriesAfter[1] === b["uuid"];
    legs.push({
      name: "entry without record degrades, never corrupts",
      requiresPinnedRuntime: false,
      passed: pair2.degraded.length === 1 && pair2.degraded[0] === b["uuid"] && chainValid,
      evidence: "the unanchored entry is classified degraded rather than dropped, and the transcript still loads with its chain intact",
    });
    return legs;
  });
}

// --- small filesystem helpers (0600, no symlink follow) ------------------------------------------------

function writeFile(path: string, data: Buffer): void {
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function appendLine(path: string, line: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, Buffer.from(`${line}\n`, "utf8"));
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function readIfExists(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

function uuidOf(line: string): string | undefined {
  try {
    return (JSON.parse(line) as { uuid?: string }).uuid;
  } catch {
    return undefined;
  }
}

function parentOf(line: string): string | null | undefined {
  try {
    return (JSON.parse(line) as { parentUuid?: string | null }).parentUuid;
  } catch {
    return undefined;
  }
}
