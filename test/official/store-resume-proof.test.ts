// P10b-6 / R1 — THE GATING PROOF: `query({ resume, sessionStore })` through the REAL 0.3.250 wrapper.
//
// WS-18 §4 (W18-8) is explicit that this path has never run: probes P1-P5 proved only that the pinned
// runtime TOLERATES the Winter dialect's entry shapes, via `-p --resume` on a file sitting inside
// `CLAUDE_CONFIG_DIR`. Production is different — `query({ resume, sessionStore })` — and the 0.3.250
// wrapper materializes the attached store into its OWN `claude-resume-<uuid>` staging root before the
// spawn hook ever runs (`src/official/spool.ts`'s header; `src/vendor-paths.ts`'s
// `resumeStagingRoot`/`isResumeStagingRoot`). Nothing in this repository had asserted, against that
// real path, that (a) the staging root the child actually gets classifies as `sdk-resume-staging`,
// (b) the prior Winter-dialect turns reach `/v1/messages` in order and unmerged (P2's whole point:
// without `message.id` claude merges assistant entries across a tool_result), (c) claude's own appends
// land back in the store under the SAME session id, and (d) `system/init` reports that same id.
//
// PER THE BRIEF: the transcript is HAND-BUILT rather than produced through the agent SDK's dialect
// writer, because `winterMessageIdFor`/`assistantEntry` (W18-11, agent SDK 0.0.10 / Lane S's S1) have
// not published yet. `SessionStoreEntry` is `{ type: string; uuid?: string; timestamp?: string; […]:
// unknown }` (structurally open), so a hand-built entry is exactly what a real Winter-dialect entry
// looks like on disk — this is not a stand-in shape.
//
// PER P10b-6: THIS TASK IS GATING. A failure here means Lane R stops and reports the evidence rather
// than building W18-8/W18-14 (the Claude-ready store, the resume door) on an unproven foundation.
//
// THE HARNESS IS THE ROUTER'S OWN: `officialRuntimeBed()`/`hermeticSession()`/`scriptedLoopback()`
// (`test/official/support.ts`) resolve the pinned platform binary through the OFFICIAL package's own
// `require` (never this host's ambient install) and drive it against a loopback fake — exactly the bed
// `test/joint/probe-legs.ts`'s `freshProcessResume` already uses for the store-backed-resume profile,
// which is why this file follows its wiring rather than inventing a second one.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";

import { WINTER_BRAND, WinterCompatibilitySessionStore, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter } from "../../src/official/index.ts";
import { createApprovalBridge } from "../../src/official/callbacks.ts";
import { createRuntimeMessaging } from "../../src/messaging/index.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import { createSharedSessionStore } from "../../src/store/index.ts";
import { isResumeStagingRoot, resumeStagingRoot } from "../../src/vendor-paths.ts";
import { cleanupHermetic, hermeticEnvPolicy, hermeticSession, officialRuntimeBed, scriptedLoopback } from "./support.ts";

const bed = officialRuntimeBed();
const describeRuntime = bed === undefined ? describe.skip : describe;
const TIMEOUT = 180_000;

/** Until agent SDK 0.0.10 (S1) publishes `winterMessageIdFor` — the exact derivation W18-11 pins. */
function winterMessageIdFor(uuid: string): string {
  return `msg_winter_${uuid.replaceAll("-", "")}`;
}

const SELECTION: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "P10b-6 / R1: the production store-backed resume proof",
  decidedAt: new Date(0).toISOString(),
};

describeRuntime("P10b-6 / R1 — query({ resume, sessionStore }) through the pinned wrapper", () => {
  afterAll(cleanupHermetic);

  test(
    "a hand-built Winter-dialect transcript resumes through the production door: staged, ordered, appended, and reported",
    async () => {
      /* c8 ignore next */
      if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
      const session = hermeticSession("store-resume-proof");
      const key: SessionKey = { projectKey: "p10b-r1-project", sessionId: randomUUID() };

      // --- the hand-built Winter-dialect transcript (per the brief, verbatim) -------------------------
      const uuidOpen = randomUUID();
      const uuidToolUse = randomUUID();
      const uuidToolResult = randomUUID();
      const uuidReply = randomUUID();
      const TOOL_CALL_ID = "call_orchid_lookup";
      const OPEN_MARKER = "remember ORCHID-47, please (R1 marker)";
      const REPLY_MARKER = "ORCHID-47 is stored (R1 marker)";
      const NEW_PROMPT = "what's the code word? (R1 follow-up)";

      const base = (uuid: string, parentUuid: string | null): Pick<SessionStoreEntry, "uuid" | "parentUuid" | "sessionId" | "timestamp" | "cwd" | "version" | "isSidechain"> => ({
        uuid,
        parentUuid,
        sessionId: key.sessionId,
        timestamp: new Date(0).toISOString(),
        cwd: session.cwd,
        version: "0.0.0",
        isSidechain: false,
      });

      const seeded: SessionStoreEntry[] = [
        { type: "user", ...base(uuidOpen, null), message: { role: "user", content: OPEN_MARKER } },
        {
          type: "assistant",
          ...base(uuidToolUse, uuidOpen),
          message: {
            id: winterMessageIdFor(uuidToolUse),
            type: "message",
            role: "assistant",
            content: [{ type: "tool_use", id: TOOL_CALL_ID, name: "lookup", input: { term: "ORCHID-47" } }],
          },
        },
        {
          type: "user",
          ...base(uuidToolResult, uuidToolUse),
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: TOOL_CALL_ID, content: "stored." }] },
        },
        {
          type: "assistant",
          ...base(uuidReply, uuidToolResult),
          message: { id: winterMessageIdFor(uuidReply), type: "message", role: "assistant", content: [{ type: "text", text: REPLY_MARKER }] },
        },
      ];

      const { peer } = createFakeWinterPeer();
      // The shared store needs the REAL concrete class off the peer (WS-05 §6): the fake winter peer
      // records `query()` calls but does not carry `WinterCompatibilitySessionStore` itself, so it is
      // spliced on here exactly as `test/store/support.ts`'s `storePeers()` does.
      const peers = { winter: { ...peer, WinterCompatibilitySessionStore }, claude: bed.module };
      const shared = createSharedSessionStore({ peers, winterHome: session.brandHome, policy: { batchWindowMs: 1 } });
      await shared.store.append(key, seeded);
      const settleBefore = await shared.settle(key);
      expect(settleBefore.errors ?? []).toHaveLength(0);
      const loadedBefore = (await shared.store.load(key)) ?? [];
      expect(loadedBefore).toHaveLength(seeded.length);

      const { routes, record } = scriptedLoopback([{ text: "resumed, and this turn is the R1 proof" }]);

      await withLoopbackFake({ routes }, async (fake) => {
        const directoryStore = createInMemoryRuntimeDirectoryStore();
        const base_ = { peers, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore };
        const { directory } = createRuntimeMessaging(base_, {});
        const context: SeamContextWithDirectory = { ...base_, directory };

        const adapter = createOfficialAdapter(context, hermeticEnvPolicy());
        await adapter.ready();

        // The CONFIGURED value is a placeholder: `spool.ts`'s own header says the wrapper hands a
        // store-backed-resume generation its OWN uuid, unpredictable from here — the classification
        // below is checked by KIND, never by equality to this value.
        const configuredPlaceholder = resumeStagingRoot(randomUUID(), session.home);

        const options = adapter.buildOptions({
          mode: "code" as const,
          selection: SELECTION,
          cwd: session.cwd,
          sessionStore: shared.store,
          autoMemoryDirectory: `${session.brandHome}/projects/${key.projectKey}/memory`,
          brand: WINTER_BRAND,
          pathToClaudeCodeExecutable: bed.executable,
          spawnProxy: adapter.spawnProxy,
          profile: "store-backed-resume" as const,
          configDir: configuredPlaceholder,
        });
        // `env.CLAUDE_CODE_PROJECT_DIR_NAME` (`projectKey` here) is what makes the WRAPPER's own
        // `sessionStore.load({ projectKey, sessionId })` land on the exact key this transcript was
        // seeded under, instead of falling back to its cwd-encoded default (which this hermetic
        // session's mkdtemp cwd would not match) — `env-allowlist.ts`'s own documented purpose for the
        // field ("decoupling the spool's project dir from the legacy encoded-cwd default").
        const env = adapter.buildChildEnv({
          selection: SELECTION,
          configDir: configuredPlaceholder,
          projectKey: key.projectKey,
          brand: WINTER_BRAND,
          credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
          base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        });

        const live = adapter.resume({
          address: `session:${key.sessionId}`,
          selection: SELECTION,
          prompt: NEW_PROMPT,
          cwd: session.cwd,
          profile: "store-backed-resume",
          configDir: configuredPlaceholder,
          resume: key.sessionId,
          options: {
            ...shared.attach(options),
            env,
            canUseTool: createApprovalBridge({ brand: WINTER_BRAND, mode: "default", broker: async (request) => ({ behavior: "allow", updatedInput: request.input }) }),
          },
        });

        const messages: Array<{ type: string; subtype?: string; session_id?: unknown }> = [];
        for await (const message of live.query) messages.push(message as { type: string; subtype?: string; session_id?: unknown });

        // --- ASSERTION 1 (W18-8): materialization under a `claude-resume-<uuid>` staging root ---------
        const observedRoot = live.supervisor.observation?.root;
        expect(observedRoot).toBeDefined();
        expect(observedRoot?.kind).toBe("sdk-resume-staging");
        expect(observedRoot?.profile).toBe("store-backed-resume");
        expect(isResumeStagingRoot(observedRoot?.configDir ?? "")).toBe(true);
        // NOT our configured placeholder: the wrapper materialized the STORE's own data into its OWN
        // freshly-minted `claude-resume-<uuid>` directory (`spool.ts`'s §1 profile 2) — proof that the
        // resume was driven by `sessionStore.load()` rather than by anything staged at the path we
        // merely configured.
        expect(observedRoot?.configDir).not.toBe(configuredPlaceholder);

        // --- ASSERTION 2 (P2): the prior turns reach the request, IN ORDER, with NO MERGE -------------
        // The real turn's request carries the whole prior transcript plus the new prompt: 5 messages.
        // A side request (a title, a summary) would carry far fewer, so the largest `messages` array is
        // unambiguously the one that matters.
        const withMessages = record.requests.filter((body) => Array.isArray(body["messages"]));
        expect(withMessages.length).toBeGreaterThan(0);
        const mainRequest = withMessages.reduce((largest, candidate) =>
          (candidate["messages"] as unknown[]).length > (largest["messages"] as unknown[]).length ? candidate : largest,
        );
        const sent = mainRequest["messages"] as Array<{ role: string; content: unknown }>;
        expect(sent.length).toBeGreaterThanOrEqual(5);

        const stringify = (content: unknown): string => JSON.stringify(content);
        const openIndex = sent.findIndex((m) => m.role === "user" && stringify(m.content).includes(OPEN_MARKER));
        const toolUseIndex = sent.findIndex((m) => m.role === "assistant" && stringify(m.content).includes(TOOL_CALL_ID) && stringify(m.content).includes("tool_use"));
        const toolResultIndex = sent.findIndex((m) => m.role === "user" && stringify(m.content).includes(TOOL_CALL_ID) && stringify(m.content).includes("tool_result"));
        const replyIndex = sent.findIndex((m) => m.role === "assistant" && stringify(m.content).includes(REPLY_MARKER));
        const newPromptIndex = sent.findIndex((m) => m.role === "user" && stringify(m.content).includes(NEW_PROMPT));

        expect(openIndex).toBeGreaterThanOrEqual(0);
        expect(toolUseIndex).toBeGreaterThan(openIndex);
        expect(toolResultIndex).toBeGreaterThan(toolUseIndex);
        expect(replyIndex).toBeGreaterThan(toolResultIndex);
        expect(newPromptIndex).toBeGreaterThan(replyIndex);
        // NO MERGE (P2's whole point): the tool-use turn and the reply turn are two DISTINCT array
        // entries, both role "assistant", separated by the tool_result — never coalesced into one.
        expect(toolUseIndex).not.toBe(replyIndex);
        expect(sent[toolUseIndex]?.role).toBe("assistant");
        expect(sent[replyIndex]?.role).toBe("assistant");
        // And no entry between them silently swallowed the tool_use's content into the reply's.
        expect(stringify(sent[replyIndex]?.content)).not.toContain(TOOL_CALL_ID);

        // --- ASSERTION 3 (W18-5/§6): claude's appends reach the store under the SAME session id -------
        await shared.settle(key);
        const loadedAfter = (await shared.store.load(key)) ?? [];
        expect(loadedAfter.length).toBeGreaterThan(loadedBefore.length);
        for (const entry of loadedAfter) {
          if (typeof entry["sessionId"] === "string") expect(entry["sessionId"]).toBe(key.sessionId);
        }
        // The seeded prefix is untouched — this is an append-only mirror, not a rewrite.
        for (let i = 0; i < seeded.length; i++) {
          expect(loadedAfter[i]?.["uuid"]).toBe(seeded[i]?.["uuid"]);
        }

        // --- ASSERTION 4 (W18-8): `init` reports the RESUMED id, not a fresh one ------------------------
        const init = messages.find((message) => message.type === "system" && message.subtype === "init");
        expect(init).toBeDefined();
        expect(init?.session_id).toBe(key.sessionId);
      });
    },
    TIMEOUT,
  );
});
