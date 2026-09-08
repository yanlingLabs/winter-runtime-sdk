// The router's own typed errors (P7b Task 1, the spine).
//
// TYPED, NEVER A COLLAPSED `Error` — WS-14 §13's own rule for the official branch's taxonomy, applied
// to the router's own surface for the same reason: a host that cannot discriminate a version-matrix
// refusal from a not-yet-implemented seam from a disposed handle has to string-match, and a string
// match is a compatibility promise nobody wrote down.
//
// Lane A owns WS-14 §13's fourteen official-branch classes (`src/official/errors.ts`); they subclass
// `RuntimeSdkError` from here so a host can catch the whole family with one `instanceof`.

/** The base class of every error this package throws. */
export class RuntimeSdkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
    // `Error.captureStackTrace` is V8-only; Bun has it, Node has it, a browser does not. Guarded so
    // this class stays importable anywhere the package is.
    const capture = (Error as unknown as { captureStackTrace?: (target: object, ctor: Function) => void }).captureStackTrace;
    if (typeof capture === "function") capture(this, new.target);
  }
}

/**
 * D19a: the injected peers are outside the tested compatibility matrix, so construction refuses.
 *
 * `expected`/`actual` are the two fields the plan pins. They are STRINGS, not objects, because the
 * one thing a host does with them is print them: `expected` is the matrix entry that was violated
 * (`"@yanlinglabs/winter-agent-sdk >=0.0.2 <0.1.0"`), `actual` is what the injected peer reported
 * (`"0.0.1"`, or `"unknown (the injected module exports no version identity and no installed copy
 * could be resolved)"`).
 */
export class RuntimeSdkVersionError extends RuntimeSdkError {
  readonly expected: string;
  readonly actual: string;
  constructor(args: { expected: string; actual: string; message?: string }) {
    super(args.message ?? `winter-runtime-sdk: version matrix refuses this peer set — expected ${args.expected}, got ${args.actual}`);
    this.expected = args.expected;
    this.actual = args.actual;
  }
}

/** Which lane of Phase 7b owns a seam that is declared but not yet implemented. */
export type LaneId = "lane-a" | "lane-b" | "lane-c" | "lane-d";

/**
 * A seam the spine pinned and a lane has not landed yet.
 *
 * DELIBERATELY A THROW, not a silent no-op or a plausible default. The spine's whole job is to let
 * four lanes build against final signatures in parallel; a stub that returned something shaped right
 * would let a lane (or a host) build on an answer nobody computed, and the failure would surface as
 * wrong behaviour somewhere else. The lane id is a field, not just prose, so a test can assert WHICH
 * seam is still open (`test/spine/seams.test.ts` does exactly that) and so a close-out check can
 * enumerate the remaining ones.
 */
export class NotImplementedYet extends RuntimeSdkError {
  readonly lane: LaneId;
  readonly seam: string;
  constructor(lane: LaneId, seam: string) {
    super(`winter-runtime-sdk: ${seam} is not implemented yet — Phase 7b ${lane} owns it (the spine ships the signature, not the behaviour)`);
    this.lane = lane;
    this.seam = seam;
  }
}

/** A `RuntimeSdk` method called after `dispose()`. */
export class RuntimeSdkDisposedError extends RuntimeSdkError {
  constructor(method: string) {
    super(`winter-runtime-sdk: ${method}() was called after dispose()`);
  }
}
