// WS-21 §3.1, §3.5, §3.7: APPLYING A RUN HOME — what the router does with the folder the host built.
//
// SYNCHRONOUS, AT THE DOOR. The Winter leg's `query()` is a pass-through and the official leg's spawn
// hook is synchronous (F13), so everything asynchronous — building the folder — is the host's, awaited
// before it calls `query()`. What happens here is the part that must never be skipped: checking that
// the folder is one the router built, for THIS leg, THIS working directory, THIS brand and THIS
// store, and then pointing the child at it.
//
// THE CHECKS ARE THE FENCE, not defensive noise:
//   * foreign — only a folder `buildRunHome` made is a run folder (spec §3.5). A hand-built object
//     could name any directory, the user's real home included;
//   * leg — a Winter-leg folder's `projects/` IS the canonical store; on the official leg claude would
//     write the store directly, around the mirror and the reconcile;
//   * cwd — the project walk, the trust decision and the settings anchors were computed for one
//     working directory;
//   * brand — the folder's names (instructions file, project dir, global config) are the brand's;
//   * store — the child's durable paths must be the store the router reconciles and hands off through.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { envName, type BrandProfile, type Options } from "@yanlinglabs/winter-agent-sdk";

import { isRouterBuiltRunHome } from "./build.ts";
import { RunHomeError } from "./errors.ts";
import { runHomeBrandOf, type RunHome, type RunLeg } from "./types.ts";
import { sessionOnlyPermissionUpdates } from "./permission-updates.ts";

export interface RunHomeApplyTarget {
  leg: RunLeg;
  /** The generation's own working directory (`Options.cwd`). */
  cwd: string | undefined;
  /** The router's resolved brand. */
  brand: BrandProfile;
  /**
   * The shared runtime home the router's store lives in. `undefined` means the router was created
   * without `requireRunHome`, i.e. on the pre-WS-21 layout, where no run home can be applied.
   */
  storeHome: string | undefined;
}

/** The refusals, in the order a host would want to hear them. Throws `RunHomeError`. */
export function assertRunHomeApplicable(runHome: unknown, target: RunHomeApplyTarget): asserts runHome is RunHome {
  if (!isRouterBuiltRunHome(runHome)) {
    throw new RunHomeError(
      "run_home_foreign",
      "`runtime.runHome` is not a run home `buildRunHome` built, or it has already been disposed; the router points a child only at a folder it built (WS-21 §3.5)",
    );
  }
  if (!existsSync(runHome.dir)) {
    throw new RunHomeError("run_home_foreign", `${runHome.dir} no longer exists; a run home is built for one generation and applied before it is disposed`);
  }
  if (target.storeHome === undefined) {
    throw new RunHomeError(
      "run_home_store_mismatch",
      "this router was created without `requireRunHome`, so its session store is on the pre-WS-21 layout; a run home can only be applied by a router whose store is the shared runtime home",
    );
  }
  if (runHome.input.leg !== target.leg) {
    throw new RunHomeError(
      "run_home_leg_mismatch",
      `this run home was built for the ${runHome.input.leg} leg and the generation runs on the ${target.leg} leg; the two legs' \`projects/\` differ (a link to the canonical store on the Winter leg, a mirrored working copy on the official leg), so it cannot be reused across them`,
    );
  }
  if (target.cwd === undefined || resolve(target.cwd) !== resolve(runHome.input.cwd)) {
    throw new RunHomeError(
      "run_home_cwd_mismatch",
      `this run home was built for ${runHome.input.cwd} and the generation's cwd is ${target.cwd === undefined ? "unset" : target.cwd}; its project walk, trust and path anchors belong to one working directory`,
    );
  }
  const built = runHomeBrandOf(runHome.input);
  for (const field of ["homeDirName", "projectDirName", "instructionsFile", "envPrefix", "mcpServerName"] as const) {
    if (built[field] !== target.brand[field]) {
      throw new RunHomeError("run_home_brand_mismatch", `this run home was built with ${field} ${JSON.stringify(built[field])} and the router's brand says ${JSON.stringify(target.brand[field])}`);
    }
  }
  if (resolve(runHome.sdkHome) !== resolve(target.storeHome)) {
    throw new RunHomeError("run_home_store_mismatch", `this run home's shared home is ${runHome.sdkHome} and the router's store lives in ${target.storeHome}; a child must write where the router reconciles and hands off`);
  }
}

/**
 * FIX ROUND 1, M1: THE OPTIONS A RUN HOME DECIDES are refused from the caller, on either leg. The run
 * folder carries the plugins (`enabledPlugins`), the skills, the agents (rewritten, F19c), the output
 * style (effective settings); the brand is the router's own. A caller-supplied agent would skip the F19c
 * rewrite, and a caller-supplied brand would re-spell the env prefix the router's variables use.
 * `trustedWorkspace` and `plansDirectory` stay: they are host policy.
 */
export const RUN_HOME_DECIDED_OPTIONS = ["plugins", "skills", "agents", "outputStyle", "brand"] as const;

export function assertNoRunHomeDecidedOptions(options: object): void {
  const present = RUN_HOME_DECIDED_OPTIONS.filter((key) => (options as Record<string, unknown>)[key] !== undefined);
  if (present.length > 0) {
    throw new RunHomeError(
      "run_home_option_refused",
      `the caller's options set ${present.join(", ")}, which a run home decides (its run folder's items and effective settings, and the router's own brand — WS-21 §3.3, §6.1); drop them from the options`,
    );
  }
}

/** The Winter child's host variables for a run home (spec §3.1, §3.7; the claude twins in comments). */
export function winterRunHomeEnv(runHome: RunHome, brand: Pick<BrandProfile, "envPrefix">): Record<string, string> {
  return {
    // CLAUDE_CONFIG_DIR's twin: the run folder is the child's home.
    [envName(brand, "HOME")]: runHome.dir,
    // Host plumbing with no claude counterpart (spec §3.7's parity note): durable paths come from here.
    [envName(brand, "STORE_HOME")]: runHome.sdkHome,
    // CLAUDE_CODE_PLUGIN_CACHE_DIR's twin.
    [envName(brand, "PLUGIN_CACHE_DIR")]: join(runHome.sdkHome, "plugins"),
    // CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST's twin (F20).
    [envName(brand, "PROVIDER_MANAGED_BY_HOST")]: "1",
    // CLAUDE_CODE_DISABLE_CRON's twin (F19a).
    [envName(brand, "DISABLE_CRON")]: "1",
  };
}

/** `autoMemoryEnabled` as the run home's effective settings say it (absent = claude's default, on). */
export function runHomeAutoMemoryEnabled(runHome: Pick<RunHome, "effectiveSettings">): boolean {
  const value = runHome.effectiveSettings["autoMemoryEnabled"];
  return typeof value === "boolean" ? value : true;
}

/**
 * The Winter leg's options for a run home: the caller's own, with the run home's env laid OVER the
 * caller's (the router's value wins for every variable only the router sets), `settingSources:
 * ["user"]`, and the auto-memory pin (`autoMemory.directory`, the twin of claude's
 * `autoMemoryDirectory`). A caller asking for the project or local source is refused: under a run
 * home the router merged those tiers itself, and a child reading them again would read the
 * repository's own files (ruling Q1).
 */
export function applyWinterRunHome<T extends Options>(options: T, runHome: RunHome, brand: Pick<BrandProfile, "envPrefix">): T {
  assertNoRunHomeDecidedOptions(options);
  // THE ROUTER'S OWN VARIABLES ARE ITS OWN (Global Constraints: "only the router sets" them). A caller
  // that still sets one — e.g. a host that used to point the Winter child at its home itself — is
  // refused rather than silently overwritten, so the leftover surfaces instead of hiding.
  const owned = new Set(Object.keys(winterRunHomeEnv(runHome, brand)).map((name) => name.toUpperCase()));
  const clashing = Object.keys(options.env ?? {}).filter((name) => owned.has(name.toUpperCase()));
  if (clashing.length > 0) {
    throw new RunHomeError(
      "router_owned_variable",
      `the caller's env sets ${clashing.join(", ")}, which only the router sets under a run home (the run folder, the shared runtime home, the plugin root and the two host switches — WS-21 §3.1); drop it from the options`,
    );
  }
  const requested = options.settingSources;
  if (requested !== undefined && requested.some((source) => source !== "user")) {
    throw new RunHomeError(
      "setting_sources_refused",
      `the Winter leg was asked for setting sources ${JSON.stringify(requested)}; under a run home the child reads the user tier only — the router merged the trusted project's tiers into it (WS-21 §3.5)`,
    );
  }
  const hostCanUseTool = options.canUseTool;
  return {
    ...options,
    env: { ...(options.env ?? {}), ...winterRunHomeEnv(runHome, brand) },
    settingSources: ["user"],
    autoMemory: { directory: runHome.input.memoryDir, enabled: runHomeAutoMemoryEnabled(runHome) },
    // WS-21 §4.3: the host's broker answer, with every durable permission-update destination rewritten
    // to `session` — the Winter child would otherwise write the repository's local settings file.
    ...(hostCanUseTool === undefined
      ? {}
      : { canUseTool: (async (...args: Parameters<NonNullable<Options["canUseTool"]>>) => sessionOnlyPermissionUpdates(await hostCanUseTool(...args))) as NonNullable<Options["canUseTool"]> }),
  };
}

/**
 * FIX ROUND 1, M6: the Winter leg's Query, observed for its END. `onEnd` runs once, when the query
 * settles — its stream done, a `return()`/`throw()` that finished it, a rejection (the runtime's own
 * failure), or `Symbol.asyncDispose` — and never before: `runHomeOutcome` answers `pending` while the
 * incarnation runs, and a host disposes only on `safe` (spec §3.8).
 *
 * WHAT "ENDS" CAN MEAN HERE: the Winter `Query` exposes no process-exit signal, so the observable end
 * is the stream's settlement, after which the SDK has closed the child's stdin. That is the same
 * point the host itself can observe; nothing later is visible through the peer.
 *
 * Every other member (`interrupt`, `setModel`, `messaging`, …) is the peer's own, bound to it, so the
 * observed query is a drop-in for the peer's.
 */
export function observeQueryEnd<Q extends AsyncGenerator<unknown, unknown, unknown>>(query: Q, onEnd: () => void): Q {
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  const settle = async <R>(step: () => Promise<IteratorResult<R>>): Promise<IteratorResult<R>> => {
    let result: IteratorResult<R>;
    try {
      result = await step();
    } catch (error) {
      end();
      throw error;
    }
    if (result.done === true) end();
    return result;
  };
  const target = query as unknown as Record<PropertyKey, unknown> & AsyncGenerator<unknown, unknown, unknown>;
  const observed: Q = new Proxy(query, {
    get(_target, property) {
      if (property === "next") return (...args: [] | [unknown]) => settle(() => target.next(...args));
      if (property === "return") return (value: unknown) => settle(() => target.return(value));
      if (property === "throw") return (error: unknown) => settle(() => target.throw(error));
      if (property === Symbol.asyncIterator) return () => observed;
      if (property === Symbol.asyncDispose) {
        return async () => {
          await settle(() => target.return(undefined));
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return observed;
}
