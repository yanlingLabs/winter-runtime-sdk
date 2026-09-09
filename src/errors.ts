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
 * The door was asked for a runtime it does not yet route to (whole-branch review, F-4).
 *
 * WHY A REFUSAL AND NOT A FALLBACK. `query()` forwards to the Winter peer; a session whose persisted
 * selection names the official runtime was, until this class existed, served by Winter SILENTLY — no
 * error, no diagnostic, and no directory record saying which runtime actually ran. That is D13's
 * "never a silent rewrite" broken at the one door the package exists for, and it is worse than a
 * refusal in the specific way that matters: the host cannot tell it happened.
 *
 * THE OFFICIAL BRANCH IS REACHABLE TODAY, just not through this door — `runtimeSdkInternals(sdk)
 * .official` is the adapter, and routing `query()` to it (building the launch plan from the
 * selection, the shared store from the store lane, the descriptors from the official lane, attaching
 * the session to the messaging registry) is its own task. The message says so, because a refusal that
 * does not name the way forward is just a wall.
 */
export class RuntimeNotRoutedError extends RuntimeSdkError {
  readonly runtimeKind: string;
  constructor(runtimeKind: string) {
    super(
      `winter-runtime-sdk: this session's selection names the ${runtimeKind} runtime, and \`query()\` routes only to the Winter peer today — serving it on Winter anyway would be the silent rewrite D13 forbids. Reach the official branch through \`runtimeSdkInternals(sdk).official\` until the door routes both branches`,
    );
    this.runtimeKind = runtimeKind;
  }
}

/**
 * A directory row whose address the router cannot name — refused at the door rather than listed.
 *
 * WHY IT IS AN ERROR AND NOT A DROPPED ROW (review r4, NEW-13). Every row the directory holds is
 * shown to a model by `ListAgents` and is then expected to answer `SendMessage`. An address that does
 * not parse fails all three resolution doors — by the listed string, by its canonicalised form, and
 * by `deliver()` on the row's own address — so the listing advertises an object nothing can reach and
 * no error explains why. A LISTED OBJECT IS ALWAYS ADDRESSABLE; the writer is an adapter recording a
 * launch, and the fix is always one line at the call site, so it is told.
 *
 * SPINE-OWNED because two lanes throw it: the directory's `record()` door and the official adapter's
 * default record sink, which is where the non-canonical address actually came from.
 */
export class UnaddressableEntryError extends RuntimeSdkError {
  readonly address: string;
  constructor(address: string) {
    super(
      `winter-runtime-sdk: ${JSON.stringify(address)} is not a canonical runtime address, so a directory row under it would be listed to the model by ListAgents and refused by every resolution door (WS-15 §6.1). Build it with serializeRuntimeAddress(buildSessionAddress(<winter session id>)) — the canonical forms are "session:<id>" and "agent:<parent>:<child>"`,
    );
    this.address = address;
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
