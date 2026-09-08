// WS-14 §6 (D12): THE SUPERVISED SPAWN PROXY.
//
// Six MUSTs, and every one of them is here because the default spawner cannot do it:
//
//   1. label the child with the product's own process label (argv0), the signed identity untouched;
//   2. validate and DURABLY RECORD `SpawnOptions.env.CLAUDE_CONFIG_DIR` BEFORE returning the process;
//   3. on an unexpected exit, DELAY forwarding the synthetic `exit` until transcript-only
//      reconciliation (or a quarantine snapshot) of the recorded root completes;
//   4. never retain staged credentials or settings;
//   5. clear the recorded root only after VERIFIED cleanup;
//   6. drain stderr continuously; forward the abort signal; report exit code/signal as typed crash
//      classes.
//
// TWO MECHANICS DESERVE THE PARAGRAPH THEY GET, because both are the difference between a rule that
// holds and a rule that is merely written down.
//
// (A) THE RECORD IS ASYNCHRONOUS AND THE HOOK IS SYNCHRONOUS. `spawnClaudeCodeProcess` returns a
// process, immediately; a durable sink returns a promise. "Before returning the process" therefore
// cannot mean "await it" — so what this proxy delivers instead is the property the rule PROTECTS: no
// byte of the child's output, and no exit, is observable by the SDK until the record has settled.
// Stdout is a `PassThrough` this proxy owns and does not connect until then, and if the record FAILS
// the child is killed and the failure surfaces on the stream rather than being swallowed. A caller
// that wants the stronger guarantee can await `whenRecorded` before iterating; the SDK cannot, so the
// gate is on the stream where the SDK actually looks.
//
// (B) THE EXIT GATE MUST COVER THE PROPERTIES, NOT ONLY THE EVENT. The pinned runtime's own
// `waitForExit` reads `this.process.exitCode === 0` and RETURNS WITHOUT WAITING FOR THE EVENT — so a
// proxy that forwarded the child's live `exitCode` while holding the `exit` event would let the SDK
// proceed to cleanup (which deletes `claude-resume-*`) with reconciliation still running. Measured in
// the 0.3.250 artifact, not inferred. This proxy therefore reports `exitCode: null`, `signalCode:
// null` and `killed: false` until the reconciliation gate opens, and reveals all three in the same
// tick it emits `exit` and ends stdout.
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import type { BrandProfile } from "@yanlinglabs/winter-agent-sdk";

import type { RuntimeDirectoryEntry, RuntimeDirectoryStore } from "../seams/directory-store.ts";
import type { SerializedRuntimeAddress } from "../seams/messaging-contract.ts";
import type { OfficialLaunchProfile } from "../seams/official-adapter.ts";
import type { OfficialSpawnClaudeCodeProcess, OfficialSpawnOptions, OfficialSpawnedProcess } from "../seams/official-sdk-shapes.ts";
import { officialBranchLabel } from "./branding.ts";
import { OfficialConnectionError, OfficialExecutableNotFoundError, OfficialKilledError, OfficialNonzeroExitError, type OfficialBranchError } from "./errors.ts";
import { validateObservedConfigDir, type ObservedLocalWriteRoot } from "./spool.ts";

/** WS-14 §9: "PID **plus process start identity** (never bare PID)" — an OS recycles pids. */
export interface ProcessIdentity {
  pid: number;
  /** ISO-8601. The pair is the identity; either half alone revalidates a stranger. */
  startedAt: string;
}

/** What the proxy observed about one generation, and what §6 rule 2 requires to be durable. */
export interface SpawnObservation {
  root: ObservedLocalWriteRoot;
  processIdentity: ProcessIdentity;
  command: string;
  args: readonly string[];
  cwd?: string;
}

/**
 * Where the observation is written durably.
 *
 * A SEAM RATHER THAN A DIRECT STORE CALL, because the sink differs by caller: the adapter's default
 * writes `RuntimeDirectoryEntry.configDir`/`processIdentity` through the spine's directory store
 * (`directoryRecordSink` below), a host with its own record writes there, and a test records into an
 * array. `clear` is §6 rule 5's other half and is optional: a sink that cannot forget is still a
 * legal sink, it just keeps a stale root.
 */
export interface SpawnRecordSink {
  record(observation: SpawnObservation): Promise<void> | void;
  clear?(observation: SpawnObservation): Promise<void> | void;
}

/**
 * §6 rule 3's collaborator: transcript-only reconciliation (or a quarantine snapshot) of the recorded
 * root, run BEFORE the exit is forwarded.
 *
 * DEFAULT IS A NO-OP, deliberately. The reconciler belongs to the store lane (WS-05 §12's barrier);
 * the proxy owns only the ORDERING, and an ordering with nothing in the middle is still the correct
 * ordering. A no-op that runs at the right moment is honest; a proxy that refused to spawn without a
 * reconciler would make the ordering untestable until another lane lands.
 *
 * "Reconciliation touches transcript/subagent files ONLY" (rule 4) — the proxy hands the reconciler
 * the root and the exit, never the environment it was spawned with.
 */
export type TranscriptReconcile = (input: { observation: SpawnObservation; exit: { code: number | null; signal: string | null } }) => Promise<void> | void;

/** The child process handle the proxy wraps — the members it drives, in Node's own shape. */
export interface SpawnedChildProcess {
  readonly pid?: number | undefined;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: string): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** How the proxy actually starts a process. Injected so a test never spawns a real binary. */
export type SpawnChild = (options: OfficialSpawnOptions & { argv0: string }) => SpawnedChildProcess;

/** The proxy plus the handles a launch needs to read what it observed. */
export interface SupervisedSpawnProxy {
  /** The hook itself, in the official runtime's own shape. */
  readonly spawn: OfficialSpawnClaudeCodeProcess;
  /** The observation of the most recent spawn, once it has happened. */
  readonly observation: SpawnObservation | undefined;
  /** Resolves when §6 rule 2's record has settled (rejects if it failed). */
  whenRecorded(): Promise<void>;
  /** Resolves when the exit gate has opened — reconciliation done, cleanup verified, record cleared. */
  whenSettled(): Promise<void>;
  /** Everything stderr produced, bounded (§6 rule 6). */
  readonly stderrTail: string;
}

export interface SupervisedSpawnProxyOptions {
  brand: Pick<BrandProfile, "processLabel" | "envPrefix">;
  /** Which profile this generation was launched as, and what config dir it was configured with (§1). */
  profile: OfficialLaunchProfile;
  configuredConfigDir: string;
  sink: SpawnRecordSink;
  reconcile?: TranscriptReconcile;
  spawnChild?: SpawnChild;
  /** Verified cleanup (§6 rule 5). Default: the recorded root no longer exists on disk. */
  verifyCleanup?: (observation: SpawnObservation) => Promise<boolean> | boolean;
  /** Typed crash classes are handed here as they are classified (§6 rule 6, §9). */
  onCrash?: (error: OfficialBranchError) => void;
  /** Bound on the retained stderr (a runaway child must not turn a message into a leak). */
  stderrTailBytes?: number;
  now?: () => Date;
}

const DEFAULT_STDERR_TAIL_BYTES = 16 * 1024;

/**
 * The default child starter: Node's own `spawn`, with the product label as argv0 (§6 rule 1).
 *
 * `node:child_process` is imported LAZILY — this module must stay importable where the module is not
 * available (the same defensiveness the Winter SDK applies to `Error.captureStackTrace`) — but the
 * hook itself is SYNCHRONOUS, so the import is resolved once, eagerly, when a proxy is prepared
 * rather than when one spawns. `prepareDefaultSpawn()` is that moment; an adapter calls it at
 * construction, and a test that injects `spawnChild` never needs it at all.
 */
let cachedSpawn: SpawnChild | undefined;

export async function prepareDefaultSpawn(): Promise<void> {
  if (cachedSpawn !== undefined) return;
  const { spawn } = await import("node:child_process");
  cachedSpawn = (options) =>
    spawn(options.command, options.args, {
      argv0: options.argv0,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    }) as unknown as SpawnedChildProcess;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/** A promise plus its resolver — the exit gate's own shape. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Builds the supervised proxy (§6). One proxy per GENERATION: it holds that generation's observation,
 * its stderr tail and its exit gate, and none of those are meaningful across two children.
 */
export function createSupervisedSpawnProxy(options: SupervisedSpawnProxyOptions): SupervisedSpawnProxy {
  const branchLabel = officialBranchLabel(options.brand);
  const now = options.now ?? (() => new Date());
  const tailLimit = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
  const spawnChild: SpawnChild =
    options.spawnChild ??
    ((opts) => {
      if (cachedSpawn === undefined) {
        throw new OfficialConnectionError({ reason: "the default child starter was not prepared; call prepareDefaultSpawn() before the first spawn or inject `spawnChild`", branchLabel });
      }
      return cachedSpawn(opts);
    });

  let observation: SpawnObservation | undefined;
  let stderrTail = "";
  let recorded: Promise<void> = Promise.resolve();
  // A DEFERRED, not a resolved promise: `whenSettled()` before the first spawn must not claim the
  // generation is over. It is replaced per spawn and resolved when that spawn's exit gate opens.
  let settleGate = deferred();
  let settled: Promise<void> = settleGate.promise;

  const appendStderr = (chunk: string): void => {
    stderrTail = (stderrTail + chunk).slice(-tailLimit);
  };

  const spawn: OfficialSpawnClaudeCodeProcess = (spawnOptions: OfficialSpawnOptions): OfficialSpawnedProcess => {
    // RULE 2, FIRST HALF — VALIDATE. The observed value is authoritative (§1); a spawn we cannot
    // account for is refused before a process exists rather than after it has written a transcript.
    const root = validateObservedConfigDir({
      observed: spawnOptions.env["CLAUDE_CONFIG_DIR"],
      configured: options.configuredConfigDir,
      profile: options.profile,
      brand: options.brand,
    });

    settleGate = deferred();
    settled = settleGate.promise;
    const thisSettleGate = settleGate;

    const child = spawnChild({ ...spawnOptions, argv0: options.brand.processLabel });
    const pid = child.pid;
    if (pid === undefined) {
      throw new OfficialConnectionError({ reason: "the child started without a pid, so it can be neither supervised nor identified (WS-14 §9)", branchLabel });
    }

    // RULE 4 — NEVER RETAIN STAGED CREDENTIALS. `spawnOptions.env` carries this session's one auth
    // family; the child gets it, this proxy keeps the CONFIG DIR and nothing else. There is
    // deliberately no field on `SpawnObservation` that could hold it.
    observation = {
      root,
      processIdentity: { pid, startedAt: now().toISOString() },
      command: spawnOptions.command,
      args: [...spawnOptions.args],
      ...(spawnOptions.cwd === undefined ? {} : { cwd: spawnOptions.cwd }),
    };
    const thisObservation = observation;

    // RULE 2, SECOND HALF — DURABLY RECORD, and gate the stream on it (see this module's header).
    //
    // The sink is CALLED SYNCHRONOUSLY, here, before this function returns: that half of "before
    // returning the process" is achievable and is therefore not compromised. Only its DURABILITY is
    // asynchronous, and that is what the stdout gate below covers. A sink that throws synchronously
    // (a malformed address, a closed store) fails the spawn outright rather than starting a child
    // whose transcript root nothing will ever know.
    recorded = Promise.resolve(options.sink.record(thisObservation)).then(() => undefined);

    const stdout = new PassThrough();
    let childStdoutEnded = false;
    let exitReported: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let gateOpen = false;
    const exitListeners: ExitListener[] = [];
    const errorListeners: ErrorListener[] = [];
    let recordFailed: Error | undefined;

    recorded.catch((error: unknown) => {
      // A record that cannot be written means a crash would leave an unfindable transcript root — the
      // exact failure §6 rule 2 exists to prevent — so the generation is ended rather than continued.
      recordFailed = error instanceof Error ? error : new Error(String(error));
      try {
        child.kill("SIGTERM");
      } catch {
        /* the child may already be gone; the error below is what the caller acts on */
      }
      stdout.destroy(recordFailed);
      for (const listener of errorListeners) listener(recordFailed);
    });

    // RULE 6 — DRAIN STDERR CONTINUOUSLY. Not on demand, not at exit: a child that fills its stderr
    // pipe and is never read BLOCKS, which looks like a hang rather than a failure.
    child.stderr?.on("data", (chunk: unknown) => appendStderr(String(chunk)));

    // Stdout is piped only after the record settles; until then the SDK sees an open, silent stream.
    const childStdout = child.stdout;
    if (childStdout === null) {
      throw new OfficialConnectionError({ reason: "the child was started without a stdout pipe, so the runtime protocol has no channel", branchLabel });
    }
    recorded
      .then(() => {
        childStdout.on("data", (chunk: unknown) => stdout.write(chunk as Uint8Array));
        childStdout.on("end", () => {
          childStdoutEnded = true;
          maybeOpenGate();
        });
      })
      .catch(() => {
        /* handled by the `recorded.catch` above — this arm exists so the rejection is not unhandled */
      });

    /**
     * RULE 3 + RULE 5 — the gate.
     *
     * Opens once the child has BOTH exited and closed stdout: reconcile the recorded root, verify the
     * cleanup, clear the record, and only then reveal the exit to the SDK. The order is the rule.
     */
    const openGate = async (): Promise<void> => {
      const exit = exitReported ?? { code: null, signal: null };
      try {
        await options.reconcile?.({ observation: thisObservation, exit: { code: exit.code, signal: exit.signal } });
      } catch (error) {
        // A reconciler that threw must not strand the process: the exit is still forwarded, and the
        // failure is reported as a crash class so the projector sees it.
        options.onCrash?.(new OfficialConnectionError({ reason: `transcript reconciliation failed for ${thisObservation.root.configDir}`, branchLabel, cause: error }));
      }
      try {
        const cleaned = (await options.verifyCleanup?.(thisObservation)) ?? true;
        if (cleaned) await options.sink.clear?.(thisObservation);
      } catch (error) {
        options.onCrash?.(new OfficialConnectionError({ reason: `verifying cleanup of ${thisObservation.root.configDir} failed`, branchLabel, cause: error }));
      }
      gateOpen = true;
      if (exit.code !== null && exit.code !== 0) {
        options.onCrash?.(new OfficialNonzeroExitError({ exitCode: exit.code, signal: exit.signal, stderrTail, branchLabel }));
      } else if (exit.signal !== null) {
        options.onCrash?.(new OfficialKilledError({ signal: exit.signal, reason: "the child was terminated by a signal", branchLabel }));
      }
      stdout.end();
      for (const listener of exitListeners) listener(exit.code, exit.signal);
      thisSettleGate.resolve();
    };

    function maybeOpenGate(): void {
      if (gateOpen || exitReported === undefined || !childStdoutEnded) return;
      void openGate();
    }

    child.on("exit", (code, signal) => {
      exitReported = { code, signal };
      maybeOpenGate();
    });
    child.on("error", (error: Error) => {
      // ENOENT here is the vendored runtime not being where the host said it was — §13's own class,
      // and the one crash a projector must be able to tell from a nonzero exit.
      const classified =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new OfficialExecutableNotFoundError({ path: spawnOptions.command, branchLabel, cause: error })
          : new OfficialConnectionError({ reason: error.message, branchLabel, cause: error });
      options.onCrash?.(classified);
      for (const listener of errorListeners) listener(error);
    });

    // RULE 6 — forward the abort signal. The SDK's own signal is already graceful (it fires after
    // stdin EOF plus a grace window), so this is the last resort rather than the first.
    spawnOptions.signal.addEventListener(
      "abort",
      () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      },
      { once: true },
    );

    const handle = {
      get stdin(): unknown {
        return child.stdin;
      },
      get stdout(): unknown {
        return stdout;
      },
      // THE GATED PROPERTIES — see this module's header (B). Until the gate opens, this process is
      // "still running" as far as the SDK's own `waitForExit` fast path is concerned.
      get killed(): boolean {
        return gateOpen && exitReported !== undefined;
      },
      get exitCode(): number | null {
        return gateOpen ? (exitReported?.code ?? null) : null;
      },
      get signalCode(): NodeJS.Signals | null {
        return gateOpen ? (exitReported?.signal ?? null) : null;
      },
      kill(signal: string): boolean {
        return child.kill(signal);
      },
      on(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
        if (event === "exit") exitListeners.push(listener as ExitListener);
        else errorListeners.push(listener as ErrorListener);
      },
      once(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
        const wrapped = ((...args: unknown[]) => {
          const list = event === "exit" ? exitListeners : errorListeners;
          const index = list.indexOf(wrapped as never);
          if (index >= 0) list.splice(index, 1);
          (listener as (...a: unknown[]) => void)(...args);
        }) as ExitListener & ErrorListener;
        if (event === "exit") exitListeners.push(wrapped);
        else errorListeners.push(wrapped);
      },
      off(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
        const list = event === "exit" ? exitListeners : errorListeners;
        const index = list.indexOf(listener as never);
        if (index >= 0) list.splice(index, 1);
      },
    };
    return handle as unknown as OfficialSpawnedProcess;
  };

  return {
    spawn,
    get observation() {
      return observation;
    },
    whenRecorded: () => recorded,
    whenSettled: () => settled,
    get stderrTail() {
      return stderrTail;
    },
  };
}

/**
 * The default sink: §6 rule 2's record written onto the directory entry the spine defined for it.
 *
 * `RuntimeDirectoryEntry.configDir` and `.processIdentity` exist precisely for this (spine fix round
 * 2, NEW-1: "WRITTEN BY Lane A's spawn proxy before it returns the process; READ BY Lane B's
 * `recover()`"), and rule 5's clear is an upsert WITHOUT the two keys — the spine's in-memory store
 * treats an absent key as absent rather than as `undefined`, which is what makes "cleared" a state a
 * reader can see.
 *
 * A MISSING ENTRY IS AN ERROR, not a silent no-op: the address is handed in by the launch, so an
 * entry that is not there means the caller recorded the session under a different address and the
 * root would be written nowhere.
 */
export function directoryRecordSink(args: { store: RuntimeDirectoryStore; address: SerializedRuntimeAddress }): SpawnRecordSink {
  const patch = async (mutate: (entry: RuntimeDirectoryEntry) => RuntimeDirectoryEntry): Promise<void> => {
    const entries = await args.store.load();
    const existing = entries.find((entry) => entry.address === args.address);
    if (existing === undefined) throw new Error(`winter-runtime-sdk: no directory entry for ${args.address}; the spawn record has nowhere to go (WS-14 §6 rule 2)`);
    await args.store.upsert(mutate(existing));
  };
  return {
    async record(observation) {
      await patch((entry) => ({
        ...entry,
        configDir: observation.root.configDir,
        processIdentity: { ...observation.processIdentity },
        updatedAt: observation.processIdentity.startedAt,
      }));
    },
    async clear() {
      await patch((entry) => {
        const { configDir: _configDir, processIdentity: _processIdentity, ...rest } = entry;
        return rest;
      });
    },
  };
}
