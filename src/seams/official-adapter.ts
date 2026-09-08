// WS-14: THE OFFICIAL-SDK ADAPTER SEAM. Lane A (`p7b/lane-a`) implements it in `src/official/**`.
//
// The router is a selector and an adapter, never a translation layer — so this seam is deliberately
// small: it BUILDS the two things the official SDK is configured by (an `Options` object and a child
// environment), it OWNS the supervised spawn proxy those options carry, and it LAUNCHES or RESUMES a
// session. The message stream itself is the official SDK's own `Query`, passed back untouched.
//
// THE OFFICIAL SDK IS NEVER IMPORTED BY THIS PACKAGE — as a value OR as a type, on the published
// surface. Its module instance is injected (`RuntimeSdkPeers.claude`), and every shape this seam
// needs is declared structurally in `./official-sdk-shapes.ts` so that a consumer who does not
// install the OPTIONAL peer can still type-check against this package (review r1, M7). That file's
// header carries the reasoning, the WS-02 §2 position, and the rule for Lane A.
//
// The spawn proxy is one of those shapes, and it is a DELIBERATE DEVIATION FROM THE PLAN'S PINNED
// LINE worth restating here because it is load-bearing. The plan types `OfficialAdapter.spawnProxy`
// as the Winter SDK's exported `SpawnClaudeCodeProcess` (`(opts: SpawnRuntimeOptions) =>
// SpawnedRuntimeProcess`). The two hooks are NOT structurally compatible — measured against both
// declarations:
//
//   Winter    `stdout: AsyncIterable<string>`, `exited: Promise<{code, signal}>`, `kill(signal?: string): void`,
//             `env: Record<string, string>`
//   official  `stdout: Readable`, `on('exit'|'error', ...)`, `kill(signal: NodeJS.Signals): boolean`,
//             `env: { [k: string]: string | undefined }`
//
// This proxy is handed to the OFFICIAL runtime (WS-14 §6 is the Claude branch's own spec, and its
// "`SpawnOptions.env.CLAUDE_CONFIG_DIR` observed value is authoritative" rule is about that runtime's
// `SpawnOptions`), so it must have that shape or it cannot be passed at all. The Winter name still
// reaches a consumer unchanged through this package's contract re-export.
import type { BrandProfile, SessionStore } from "@yanlinglabs/winter-agent-sdk";

import type { OfficialOptions, OfficialQuery, OfficialSpawnClaudeCodeProcess, OfficialUserMessage } from "./official-sdk-shapes.ts";
import type { RuntimeSelection } from "../selection/runtime-selection.ts";

export type { OfficialOptions, OfficialQuery, OfficialSpawnClaudeCodeProcess, OfficialUserMessage };

/**
 * WS-14 §1: `CLAUDE_CONFIG_DIR` has TWO values by launch profile.
 *
 * `fresh-spool` — `<winterHome>/runtimes/official-agent-spool`, the spool a fresh or spool-resident
 * generation lives in. `store-backed-resume` — `<tmpdir>/claude-resume-<uuid>`, a throwaway root for
 * a generation resumed out of the shared session store.
 */
export type OfficialLaunchProfile = "fresh-spool" | "store-backed-resume";

/** What `buildOptions` is given. Every field is something WS-14 §2/§5 pins as normative. */
export interface OptionsTemplateInput {
  mode: "code" | "dispatch" | "chat";
  selection: RuntimeSelection;
  cwd: string;
  /** The ONE shared store instance/version both branches consume (WS-05 §6, WS-14 §5). */
  sessionStore: SessionStore;
  /** The one shared auto-memory directory, identical for both branches (WS-14 §2). */
  autoMemoryDirectory: string;
  /** Winter-owned names come from here; Claude-mirroring literals stay fixed (WS-01 §5 / D16). */
  brand: BrandProfile;
  /** WS-14 §5.1: the VENDORED runtime — never the user's installed Claude binary. */
  pathToClaudeCodeExecutable: string;
  spawnProxy: OfficialSpawnClaudeCodeProcess;
  profile: OfficialLaunchProfile;
  /** The value this generation is CONFIGURED with; §6's observed value is what gets recorded. */
  configDir: string;
}

/** What `buildChildEnv` is given. WS-14 §3: the child env is a REPLACEMENT built from an allowlist. */
export interface EnvInput {
  selection: RuntimeSelection;
  configDir: string;
  /**
   * The RESOLVED brand profile (I2). Every Winter-owned name in the child environment derives from
   * it — `envName(brand, …)` for anything this branch is told to pass, and the spool/home segments
   * WS-14 §1 builds. Never a literal: the brand gate forbids one, and a reuser's child would
   * otherwise be handed Winter's names.
   */
  brand: BrandProfile;
  /**
   * Exactly one auth family's variables, fetched from the host's Keychain seam AT SPAWN and never
   * written to disk (WS-14 §12). The adapter must not retain them (§6).
   */
  credentials: Readonly<Record<string, string>>;
  /** The minimal OS variables the child needs (PATH, HOME, …). Nothing is inherited implicitly. */
  base?: Readonly<Record<string, string>>;
}

export interface OfficialLaunchPlan {
  selection: RuntimeSelection;
  prompt: string | AsyncIterable<OfficialUserMessage>;
  options: OfficialOptions;
  profile: OfficialLaunchProfile;
  configDir: string;
  cwd: string;
}

export interface OfficialResumePlan extends OfficialLaunchPlan {
  /** The backend session id to resume (WS-05 §7's resolution rules apply to finding it). */
  resume: string;
  /** A visible fork rather than a resume (WS-00 §2 D13's "never a silent rewrite"). */
  forkSession?: boolean;
}

/** A live official generation. The `query` is the official SDK's own — the stream passes through. */
export interface OfficialSession {
  readonly query: OfficialQuery;
  /**
   * The `CLAUDE_CONFIG_DIR` this generation actually got, read from `SpawnOptions.env` — never the
   * value that was configured (WS-14 §6 rule 2).
   *
   * THE DURABLE HALF OF THAT RULE IS `RuntimeDirectoryEntry.configDir`, and this field is the live
   * copy beside it. Until fix round 2 this doc comment promised a record with no sink behind it;
   * recording it is Lane A's spawn proxy's job, before the process is returned, and the seam that
   * receives it is the directory store's.
   */
  readonly configDir: string;
  readonly profile: OfficialLaunchProfile;
  readonly selection: RuntimeSelection;
}

/** WS-14 §1–§13. Lane A implements; the spine pins the signature. */
export interface OfficialAdapter {
  launch(plan: OfficialLaunchPlan): OfficialSession;
  resume(plan: OfficialResumePlan): OfficialSession;
  buildOptions(input: OptionsTemplateInput): OfficialOptions;
  buildChildEnv(input: EnvInput): Record<string, string>;
  readonly spawnProxy: OfficialSpawnClaudeCodeProcess;
}
