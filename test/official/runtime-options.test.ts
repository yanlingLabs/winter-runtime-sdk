// THE MEASUREMENT THE WHOLE §2 REDESIGN RESTS ON, committed (review r1, m3).
//
// `options-template.ts` says `plansDirectory`/`autoMemoryEnabled`/`autoMemoryDirectory` are delivered
// through `Options.settings` — the flag settings layer — because they are not on the pinned runtime's
// `Options` at all, and it cited a file that did not exist. Nothing committed proved the layer was
// live. This is that proof, plus the bed gate the review asked for.
//
// WHY `model` IS THE PROBE. The three fields §2 names produce no observable request field of their
// own: `plansDirectory` only shows when a plan file is written (and this runtime's SDK path writes
// none), and auto-memory only shows when the model reads or writes memory. `model` is a field of the
// SAME `Settings` object, delivered through the SAME door, and it lands in the request body where a
// loopback fake can read it. If the flag layer is live for `model` it is live for its neighbours; if
// it were ignored, the request would carry the runtime's own default instead.
import { afterAll, describe, expect, test } from "bun:test";
import { WINTER_BRAND, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import { stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter } from "../../src/official/index.ts";
import { cleanupHermetic, hermeticSession, officialRuntimeBed, scriptedLoopback } from "./support.ts";

const bed = officialRuntimeBed();
const describeRuntime = bed === undefined ? describe.skip : describe;

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "the settings-layer probe",
  decidedAt: new Date(0).toISOString(),
};

class PassthroughStore {
  async append(): Promise<void> {}
  async load(): Promise<never[]> {
    return [];
  }
  async listSubkeys(): Promise<never[]> {
    return [];
  }
}

/** A model id that is nobody's default, so seeing it means the flag layer put it there. */
const FLAG_LAYER_MODEL = "claude-opus-4-5-20251101";

describeRuntime("WS-14 §2 — the settings layer is the door (review r1, m3)", () => {
  afterAll(cleanupHermetic);

  test(
    "a `settings` field with NO top-level twin reaches the runtime",
    async () => {
      /* c8 ignore next */
      if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
      const session = hermeticSession("options");
      const { routes, record } = scriptedLoopback([{ text: "ok" }]);

      await withLoopbackFake({ routes }, async (fake) => {
        const base = { peers: { winter: createFakeWinterPeer().peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore: createInMemoryRuntimeDirectoryStore() };
        const context: SeamContextWithDirectory = { ...base, directory: stubRuntimeDirectory(base) };
        // The template policy rides on the ADAPTER (the seam's `buildOptions` takes one argument), so
        // this is also how a host would set it.
        const adapter = createOfficialAdapter(context, { options: { settings: { model: FLAG_LAYER_MODEL } } });
        const env = adapter.buildChildEnv({
          selection,
          configDir: session.spool,
          brand: WINTER_BRAND,
          credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
          base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        });
        const options = adapter.buildOptions({
            mode: "code",
            selection,
            cwd: session.cwd,
            sessionStore: new PassthroughStore() as unknown as SessionStore,
            autoMemoryDirectory: `${session.brandHome}/projects/options/memory`,
            brand: WINTER_BRAND,
            pathToClaudeCodeExecutable: bed.executable,
            spawnProxy: adapter.spawnProxy,
            profile: "fresh-spool",
            configDir: session.spool,
        });
        // The three §2 fields ride the same object, and no top-level `model` competes with it.
        expect((options.settings as { plansDirectory: string; autoMemoryEnabled: boolean; autoMemoryDirectory: string }).plansDirectory).toBe(".winter/plans");
        expect(options["model"]).toBeUndefined();

        const live = adapter.launch({ address: "session:options", selection, prompt: "hello", cwd: session.cwd, profile: "fresh-spool", configDir: session.spool, options: { ...options, env } });
        for await (const _message of live.query) {
          /* drained: the assertion is on what the runtime ASKED FOR */
        }
      });

      const models = record.requests.map((request) => request["model"]).filter((model): model is string => typeof model === "string");
      expect(models.length).toBeGreaterThan(0);
      // THE MEASUREMENT: the flag settings layer is applied, so the three fields §2 names are
      // genuinely delivered by this door rather than silently ignored the way an unknown `Options`
      // key would be.
      expect(models).toContain(FLAG_LAYER_MODEL);
    },
    180_000,
  );
});

describe("the real-runtime bed itself (review r1, m6)", () => {
  test("in CI, a missing platform package is a FAILURE rather than a quiet skip", () => {
    // Five rows' worth of evidence rides on the bed resolving. Locally a developer without the
    // optional platform package gets a printed skip; in CI a skip would be a green suite with the
    // proofs silently absent, which is the failure mode this whole lane keeps meeting.
    if (process.env["CI"] === undefined) {
      expect(true).toBe(true);
      return;
    }
    expect(officialRuntimeBed()).toBeDefined();
  });
});
