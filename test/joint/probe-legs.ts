// THE `freshProcessResume` COLLABORATOR — items 11 and 23, made concrete.
//
// Three of WS-17 §8's four materialized-resume probes name THE PINNED OFFICIAL RUNTIME, and Lane C
// could not supply one: its lane had no bed that spawns 0.3.250, so those legs recorded "unexercised"
// and the PREFERRED door stayed shut for the honest reason. This file is the missing half — Lane A's
// bed, in the shape Lane C's `PinnedRuntimeProbeLegs` declares.
//
// WHAT A LEG HAS TO DO, precisely: start a FRESH PROCESS of the pinned runtime on a STORE-BACKED
// RESUME of `key`, reading from `stagingRoot` (which is that generation's `CLAUDE_CONFIG_DIR`,
// WS-14 §1's profile 2) with the SHARED store attached as `Options.sessionStore`, and return once the
// generation has ended. Everything the probes then assert — that the sidecar beside the transcript is
// byte-untouched, that no decorated entry washes back into the canonical file — is about what that
// real process did to a real store.
//
// THE STORE IS ATTACHED THROUGH `shared.attach`, not by hand: §5.1 refuses two option combinations
// and the attach door is where that refusal lives. A probe that hand-set `sessionStore` would be
// measuring a configuration the router would never produce.
//
// HERMETIC (F-1): the child gets the four traffic opt-outs, so what it does is the artifact's own
// behaviour rather than the artifact plus a feature flag.
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import type { SessionKey } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import { createOfficialAdapter } from "../../src/official/index.ts";
import { createApprovalBridge } from "../../src/official/callbacks.ts";
import type { PinnedRuntimeProbeLegs, SharedSessionStore } from "../../src/store/index.ts";
import { hermeticEnvPolicy, hermeticSession, officialRuntimeBed, scriptedLoopback } from "../official/support.ts";
import { jointSelection } from "./support.ts";

/**
 * Lane A's bed, as Lane C's probe collaborator.
 *
 * Returns `undefined` where the pinned runtime cannot run (no platform binary for this host), which
 * is exactly what keeps the door shut for the honest reason rather than failing a suite.
 */
export function pinnedRuntimeProbeLegs(): PinnedRuntimeProbeLegs | undefined {
  const bed = officialRuntimeBed();
  if (bed === undefined) return undefined;
  return {
    label: `the pinned official runtime ${bed.version} on ${process.platform}-${process.arch}, over a loopback fake`,
    async freshProcessResume(args: { home: string; stagingRoot: string; key: SessionKey; shared: SharedSessionStore }): Promise<void> {
      const session = hermeticSession("probe-resume");
      // ONE assistant turn: the probes need the resume to PRODUCE entries (a resume that wrote
      // nothing tests nothing, and Lane C's probe records that case as unexercised rather than as a
      // pass), and one turn is the least that does.
      const { routes } = scriptedLoopback([{ text: "resumed, and this turn is what the probe measures" }]);
      await withLoopbackFake({ routes }, async (fake) => {
        const directoryStore = createInMemoryRuntimeDirectoryStore();
        const { peer } = createFakeWinterPeer();
        const base = { peers: { winter: peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore };
        const { createRuntimeMessaging } = await import("../../src/messaging/index.ts");
        const { directory } = createRuntimeMessaging(base, {});
        const context: SeamContextWithDirectory = { ...base, directory };
        const adapter = createOfficialAdapter(context, hermeticEnvPolicy());
        await adapter.ready();

        const options = adapter.buildOptions({
          mode: "code" as const,
          selection: jointSelection,
          cwd: session.cwd,
          // THE SHARED STORE, through its own attach door.
          sessionStore: args.shared.store,
          autoMemoryDirectory: `${session.brandHome}/projects/probe/memory`,
          brand: WINTER_BRAND,
          pathToClaudeCodeExecutable: bed.executable,
          spawnProxy: adapter.spawnProxy,
          // WS-14 §1's profile 2: the staging root IS this generation's config dir.
          profile: "store-backed-resume" as const,
          configDir: args.stagingRoot,
        });
        const env = adapter.buildChildEnv({
          selection: jointSelection,
          configDir: args.stagingRoot,
          brand: WINTER_BRAND,
          credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
          base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        });
        const live = adapter.resume({
          address: `session:${args.key.sessionId}`,
          selection: jointSelection,
          prompt: "continue",
          cwd: session.cwd,
          profile: "store-backed-resume",
          configDir: args.stagingRoot,
          resume: args.key.sessionId,
          options: {
            ...args.shared.attach(options),
            env,
            canUseTool: createApprovalBridge({ brand: WINTER_BRAND, mode: "default", broker: async (request) => ({ behavior: "allow", updatedInput: request.input }) }),
          },
        });
        // "…and returns once the generation has ended" — the probe measures the store AFTER this.
        for await (const _ of live.query) void _;
      });
    },
  };
}
