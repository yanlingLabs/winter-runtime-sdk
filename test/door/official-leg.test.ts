// TASK 6b — `RuntimeSdk.query()` SERVES THE OFFICIAL RUNTIME, for real.
//
// Every assertion below is made against the pinned 0.3.250 binary, launched by the router's own handle
// through the one door. Nothing in this file calls a lane factory: if the door composed the lanes
// wrongly, these tests are what notices.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WinterCompatibilitySessionStore, transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";

import { createRuntimeSdk, RuntimeHandoffRequiredError, RuntimeLaunchInputError, isOfficialQuery, runtimeSdkInternals, type RuntimeSdkPeers } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { TRAFFIC_OPT_OUT_VARIABLE_NAMES } from "../../src/official/env-allowlist.ts";
import { cleanupHermetic, officialRuntimeBed } from "../official/support.ts";
import { envelope, sessionEntry } from "../messaging/support.ts";
import { DOOR_CREDENTIAL, DOOR_TIMEOUT, doorSelection, drain, withDoorBed } from "./support.ts";

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;

describeRuntime("the door's official leg, against the pinned runtime", () => {
  afterAll(cleanupHermetic);

  test(
    "a claude-agent selection reaches the real runtime and yields system/init",
    async () => {
      await withDoorBed({ turns: [{ text: "hello from the pin" }] }, async (bed) => {
        const query = bed.sdk.query({ prompt: "say hello", options: bed.officialOptions() });
        // THE HANDLE IS THE OFFICIAL LEG'S, and the package says so by registry rather than by sniffing.
        expect(isOfficialQuery(query)).toBe(true);
        const messages = await drain(query);

        const init = messages.find((message) => message.type === "system" && message.subtype === "init");
        expect(init).toBeDefined();
        expect(messages.at(-1)?.type).toBe("result");
        // …and NOTHING but the loopback endpoint was reached: the four traffic opt-outs are on by
        // default now, so the child never asked a CDN what tools it should have.
        expect(new Set(bed.record.paths)).toEqual(new Set(["/api/hello", "/v1/messages"]));
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "the directory holds the official session with its configDir and processIdentity",
    async () => {
      await withDoorBed({ turns: [{ text: "recorded" }], sessionId: "door-record" }, async (bed) => {
        // READ WHILE THE GENERATION IS LIVE. §6 rule 5 CLEARS the pair after verified cleanup, so a row
        // read after the drain has (correctly) neither field — the record's lifecycle is the point of
        // the rule, and a test that read it afterwards would be asserting the wrong half of it.
        const query = bed.sdk.query({ prompt: "hi", options: bed.officialOptions() });
        const iterator = (query as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await iterator.next();
        const row = await bed.sdk.directory.get(bed.address);
        expect(row).toBeDefined();
        expect(row?.runtimeKind).toBe("claude-agent");
        expect(row?.transport).toBe("claude-handle");
        // WS-14 §6 rule 2: the OBSERVED root, written before the process was returned.
        expect(row?.configDir).toBe(bed.session.spool);
        expect(typeof row?.processIdentity?.pid).toBe("number");
        expect(typeof row?.processIdentity?.startedAt).toBe("string");
        // D13: the selection is persisted at creation, by the door, not by a host afterwards.
        expect(row?.selection.runtimeKind).toBe("claude-agent");
        expect(row?.selection.modelRef).toBe("loopback/claude-sonnet-4-5");
        // R-7b-11: which of the pin's two tool surfaces this session ran with.
        expect(row?.remoteConfig).toBe("deny");

        // REVIEW r1, I-2 — THE BACKEND ID THE VENDOR ALLOCATED IS ON THE ROW.
        // Without it `findEntry` has nothing to match and `sdk.handoff()` — the remedy this door's own
        // refusal names — fails for every session the door opened.
        const init = (await bed.sdk.directory.get(bed.address))?.backendSessionId;
        expect(typeof init).toBe("string");
        expect(init).toMatch(/^[0-9a-f-]{36}$/);

        // …and the identity survives the generation; only the live pair is cleared (§6 rule 5).
        while (!(await iterator.next()).done) void 0;
        const after = await bed.sdk.directory.get(bed.address);
        expect(after?.runtimeKind).toBe("claude-agent");
        expect(after?.selection.runtimeKind).toBe("claude-agent");
        expect(after?.processIdentity).toBeUndefined();
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "the backend session id makes `sdk.handoff()` — this door's own named remedy — reachable",
    async () => {
      await withDoorBed({ turns: [{ text: "handoffable" }], sessionId: "door-handoff" }, async (bed) => {
        const messages = await drain(bed.sdk.query({ prompt: "hi", options: bed.officialOptions() }));
        const init = messages.find((message) => message.type === "system" && message.subtype === "init") as { session_id?: string } | undefined;
        expect(typeof init?.session_id).toBe("string");
        const row = await bed.sdk.directory.get(bed.address);
        expect(row?.backendSessionId).toBe(init?.session_id as string);

        // THE ROUTE THE REFUSAL NAMES, actually taken: `plan()` finds the row by the backend id.
        // Before I-2 this was `HandoffPlanError: … it is not in the runtime directory`.
        const internals = runtimeSdkInternals(bed.sdk);
        const plan = await internals?.barrier.plan({ projectKey: bed.projectKey, sessionId: init?.session_id as string }, "winter-agent");
        expect(plan?.to).toBe("winter-agent");
        expect(plan?.from).toBe("claude-agent");
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "`sdk.messaging.listReachable` sees the session the door created — WHILE IT IS LIVE",
    async () => {
      await withDoorBed({ turns: [{ text: "listed" }], sessionId: "door-listed" }, async (bed) => {
        // LISTED WHILE LIVE (review r1's last nit). Listing after the drain used to pass for I-3's
        // reason — the row stayed `running` for ever — so the test was green about the wrong thing.
        const query = bed.sdk.query({ prompt: "hi", options: bed.officialOptions() });
        const iterator = (query as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        await iterator.next();
        // Asked from a DIFFERENT session, because a listing never shows the asker itself.
        const from = { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "someone-else" } as const;
        const rows = await bed.sdk.messaging.listReachable({ from });
        const listed = rows.find((row) => row.address === bed.address);
        expect(listed).toBeDefined();
        expect(listed?.runtimeKind).toBe("claude-agent");

        // …and after the generation ends the row is NOT running and the listing drops it (I-3a).
        while (!(await iterator.next()).done) void 0;
        expect((await bed.sdk.directory.get(bed.address))?.status).toBe("exited");
        const after = await bed.sdk.messaging.listReachable({ from });
        expect(after.find((row) => row.address === bed.address)).toBeUndefined();
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "after a streaming session's input ended and the runtime exited, a delivery is `unavailable` — never uncertain",
    async () => {
      await withDoorBed({ turns: [{ text: "one turn" }], sessionId: "door-afterend" }, async (bed) => {
        await bed.sdk.directory.record(sessionEntry("sender"));
        const turns = (async function* () {
          yield "start";
        })();
        // A STREAMING session, so the door owns the input stream and attaches the handle.
        await drain(bed.sdk.query({ prompt: turns, options: bed.officialOptions() }));

        const outcome = await bed.sdk.messaging.deliver(
          envelope({
            messageId: "after-end-1",
            from: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "sender" },
            to: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId: bed.sessionId },
            body: "anyone home?",
            createdAt: Date.now(),
            expiresAt: Date.now() + 600_000,
          }),
        );
        // BEFORE I-3 this was `delivery_uncertain` with `deliveryMayHaveOccurred: true` — "the write
        // may have landed" for a session where nothing could land, and the stale handle also hid the
        // honest route behind it.
        expect(outcome.status).toBe("unavailable");
        if (outcome.status === "unavailable") expect(outcome.retryable).toBe(false);
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "the child environment carries R-7b-11's four opt-outs, and the model request proves the surface",
    async () => {
      await withDoorBed({ turns: [{ text: "measured" }], sessionId: "door-optouts" }, async (bed) => {
        await drain(bed.sdk.query({ prompt: "hi", options: bed.officialOptions() }));
        const tools = (bed.record.requests.at(-1)?.["tools"] ?? []) as Array<{ name?: string; type?: string }>;
        const names = new Set(tools.map((tool) => (tool.type === undefined ? String(tool.name) : `${tool.type}:${String(tool.name)}`)));
        // The four remotely-gated entries measured on this pin. Their absence is the opt-outs working;
        // their presence would mean a CDN answered and the "pinned artifact" claim is not one artifact.
        for (const gated of ["DesignSync", "Monitor", "PushNotification", "advisor_20260301:advisor"]) {
          expect({ gated, advertised: names.has(gated) }).toEqual({ gated, advertised: false });
        }
        expect(TRAFFIC_OPT_OUT_VARIABLE_NAMES).toHaveLength(4);
      });
    },
    DOOR_TIMEOUT,
  );

  // ==================================================================================================
  // REVIEW r1, M-2 / RULING R-7b-13 — THE TRANSCRIPT KEY IS WINTER'S, AND A KEY THE PIN REJECTS IS
  // REFUSED RATHER THAN SUBSTITUTED.
  //
  // The default used to be the SESSION ID, so for one working directory the two branches wrote to two
  // project directories and two auto-memory directories — against WS-14 §3 ("Winter's stable transcript
  // key") and §2 ("ONE shared auto-memory directory, identical for both branches") — and the
  // `projectKey` half of the `SessionKey` a host must pass to `sdk.handoff()` was a per-session value
  // nothing documented.
  // ==================================================================================================
  test(
    "the default transcript key is the Winter SDK's own, and the runtime really writes under it",
    async () => {
      await withDoorBed({ turns: [{ text: "keyed" }], sessionId: "door-key" }, async (bed) => {
        await drain(bed.sdk.query({ prompt: "hi", options: bed.officialOptions() }));
        const expected = transcriptProjectKey(bed.session.cwd);
        expect(bed.projectKey).toBe(expected);
        // THE PROOF IS THE RUNTIME'S OWN FILESYSTEM, not our env object: the vendor writes its
        // transcript under `<CLAUDE_CONFIG_DIR>/projects/<CLAUDE_CODE_PROJECT_DIR_NAME>/`, and it
        // substitutes its own key when it rejects ours — so the directory's NAME is what says which
        // key actually took effect.
        expect(readdirSync(join(bed.session.spool, "projects"))).toEqual([expected]);
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "a key the pinned runtime would reject is refused BEFORE any spawn, never substituted",
    async () => {
      await withDoorBed({ turns: [{ text: "unused" }], sessionId: "door-longkey" }, async (bed) => {
        const options = bed.officialOptions() as Record<string, unknown>;
        (options["runtime"] as { official: Record<string, unknown> }).official["projectKey"] = "k".repeat(70);
        const query = bed.sdk.query({ prompt: "hi", options });
        const failure: unknown = await drain(query as AsyncIterable<unknown>).then((): unknown => undefined, (error: unknown): unknown => error);
        expect((failure as Error).message).toContain("does not match the pinned runtime's own rule");
        expect((failure as Error).message).toContain("70 characters");
        // Nothing spawned, nothing recorded — the substitution never got the chance to happen.
        expect(bed.record.requests).toHaveLength(0);
        expect(await bed.sdk.directory.get(bed.address)).toBeUndefined();
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "a per-query template policy wins over the deployment-wide one (review r1, L-1)",
    async () => {
      await withDoorBed({ turns: [{ text: "appended" }], sessionId: "door-policy" }, async (bed) => {
        // The handle carries a deployment default; this query says something else for ITSELF. The
        // spreads used to be the other way round, so the deployment silently overrode the caller —
        // inconsistent with `remoteConfig`, whose per-query value has always won.
        const options = bed.officialOptions() as Record<string, unknown>;
        (options["runtime"] as { official: Record<string, unknown> }).official["options"] = { systemPromptAppend: "PER-QUERY" };
        await drain(bed.sdkWith({ official: { options: { systemPromptAppend: "DEPLOYMENT" } } }).query({ prompt: "hi", options }));
        const system = JSON.stringify(bed.record.requests.at(-1)?.["system"] ?? "");
        expect(system).toContain("PER-QUERY");
        expect(system).not.toContain("DEPLOYMENT");
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "a resume bumps the row's generation (review r1, L-2)",
    async () => {
      await withDoorBed({ turns: [{ text: "one" }], sessionId: "door-generation" }, async (bed) => {
        const first = await drain(bed.sdk.query({ prompt: "hi", options: bed.officialOptions() }));
        const init = first.find((message) => message.type === "system" && message.subtype === "init") as { session_id?: string } | undefined;
        expect((await bed.sdk.directory.get(bed.address))?.generation).toBe(1);

        // A plain `options.resume` is a REPLACEMENT PROCESS, and WS-15 §6.1 stamps deliveries with the
        // target generation so "a stale send cannot reach a replacement process". The row used to be
        // re-written `generation: 1` for every one of them.
        const options = bed.officialOptions() as Record<string, unknown>;
        options["resume"] = init?.session_id;
        (options["runtime"] as { official: Record<string, unknown> }).official["stagingRoot"] = bed.session.spool;
        await drain(bed.sdk.query({ prompt: "again", options }));
        expect((await bed.sdk.directory.get(bed.address))?.generation).toBe(2);
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "a mid-session runtime change is refused against the DURABLE row, before anything launches",
    async () => {
      await withDoorBed({ turns: [{ text: "unused" }], sessionId: "door-persisted" }, async (bed) => {
        // The row says this session belongs to the OTHER runtime — the state a restart leaves behind,
        // which the door's in-process ledger cannot see.
        await bed.sdk.directory.record({
          address: bed.address,
          parsed: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: bed.sessionId },
          runtimeKind: "winter-agent",
          objectKind: "session",
          transport: "winter-session",
          status: "idle",
          mode: "code",
          generation: 1,
          selection: { ...doorSelection, runtimeKind: "winter-agent" },
          capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
          updatedAt: new Date(0).toISOString(),
        });
        const query = bed.sdk.query({ prompt: "continue on the other runtime", options: bed.officialOptions() });
        // The refusal is at the LAUNCH, which is the first pull — so nothing was spawned and no
        // credential was read to get here.
        const failure = await drain(query).then((): unknown => undefined, (error: unknown): unknown => error);
        expect(failure).toBeInstanceOf(RuntimeHandoffRequiredError);
        expect((failure as RuntimeHandoffRequiredError).from).toBe("winter-agent");
        expect((failure as Error).message).toContain("sdk.handoff");
        // Untouched: no model request was ever made.
        expect(bed.record.requests).toHaveLength(0);

        // REVIEW r1, I-1 (the E4 arm) — THE LEDGER LEARNED WHAT THE ROW SAYS, not what was refused.
        // The honest follow-up after this refusal is a query on the runtime the row actually names;
        // before I-1 the ledger held `claude-agent` from the DECISION and refused that too, wedging the
        // session on both legs with no `sdk.handoff()` able to move it (it had never been on claude).
        const winterAfter = bed.sdk.query({
          prompt: "continue where the row says",
          options: { runtime: { sessionId: bed.sessionId, selection: { ...doorSelection, runtimeKind: "winter-agent" } } },
        });
        for await (const _ of winterAfter as AsyncIterable<unknown>) void _;
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "`close()` before the first pull starts nothing at all",
    async () => {
      await withDoorBed({ turns: [{ text: "never" }], sessionId: "door-closed" }, async (bed) => {
        const query = bed.sdk.query({ prompt: "hi", options: bed.officialOptions() }) as { close?: () => void };
        expect(typeof query.close).toBe("function");
        query.close?.();
        expect(bed.record.requests).toHaveLength(0);
        expect(await bed.sdk.directory.get(bed.address)).toBeUndefined();
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "the handle forwards the vendor's own members, and `interrupt()` answers in the vendor's own shape",
    async () => {
      await withDoorBed({ turns: [{ text: "one" }, { text: "two" }], sessionId: "door-members" }, async (bed) => {
        const query = bed.sdk.query({ prompt: "hi", options: bed.officialOptions() }) as AsyncIterable<{ type: string }> & {
          supportedModels?: () => Promise<unknown>;
          interrupt(): Promise<unknown>;
          then?: unknown;
        };
        // A HANDLE THAT LOOKED THENABLE WOULD BE SWALLOWED BY ANY `await`.
        expect(query.then).toBeUndefined();

        const iterator = query[Symbol.asyncIterator]();
        await iterator.next();
        // A member this package never names, reached through the forwarding handle.
        const models = await query.supportedModels?.();
        expect(Array.isArray(models)).toBe(true);
        // WS-14 §9's interrupt, and its RESPONSE SHAPE recorded rather than assumed.
        const response = await query.interrupt();
        // eslint-disable-next-line no-console
        console.log(`[door] interrupt() response: ${JSON.stringify(response)}`);
        expect(response === undefined || typeof response === "object").toBe(true);
        await iterator.return?.(undefined);
      });
    },
    DOOR_TIMEOUT,
  );
});

describe("the door's official leg — the inputs only a host can supply", () => {
  test("a claude-agent selection with no `runtime.official` refuses rather than guessing a session id", () => {
    // Covered end-to-end in `test/spine/query-passthrough.test.ts`; repeated here as the leg's own
    // contract, because "the door needs a session id" is the sentence a host reads first.
    expect(new RuntimeLaunchInputError({ field: "runtime.official", reason: "x" }).field).toBe("runtime.official");
  });
});

// ====================================================================================================
// REVIEW r1, I-3(c) — A GENERATION THAT NEVER EXISTED LEAVES NO ROW.
//
// The row is written BEFORE the launch on purpose: a host asking `listReachable()` between the launch
// and the first message must not be told the session does not exist. But a launch that refuses
// SYNCHRONOUSLY used to leave `status: "running"`, `runtimeKind: "claude-agent"` and a listing entry
// with nothing behind it. No pinned runtime is needed to prove it — the refusal is the adapter's own,
// for the most ordinary reason there is: no official peer was injected.
// ====================================================================================================
describe("the door's official leg — a refused launch", () => {
  test("leaves no phantom row behind", async () => {
    // SHORT, so the DEFAULT transcript key fits the pin's 64-character rule (R-7b-13) and this test
    // reaches the launch it is about rather than the key refusal.
    const root = mkdtempSync(join(tmpdir(), "w-"));
    try {
      const { peer } = createFakeWinterPeer();
      const sdk = createRuntimeSdk({
        // NO `claude` peer: `launch()` refuses with `OfficialConfigurationError: peers.claude`.
        peers: { winter: { ...peer, WinterCompatibilitySessionStore } as unknown as RuntimeSdkPeers["winter"] },
        keychain: createFakeKeychain([{ ref: DOOR_CREDENTIAL, material: "sk-ant-fake" }]),
        vendoredOfficialRuntime: "/vendored/claude",
        handoff: { winterHome: join(root, "home") },
      });
      const query = sdk.query({
        prompt: "hi",
        options: {
          cwd: join(root, "w"),
          runtime: {
            selection: doorSelection,
            official: { sessionId: "phantom", credentials: [{ variable: "ANTHROPIC_API_KEY", ref: DOOR_CREDENTIAL }], base: { HOME: join(root, "home"), PATH: "/usr/bin" } },
          },
        },
      });
      const failure: unknown = await drain(query as AsyncIterable<unknown>).then((): unknown => undefined, (error: unknown): unknown => error);
      expect((failure as Error).message).toContain("peers.claude");
      // THE POINT: nothing was launched, so nothing is listed.
      expect(await sdk.directory.get("session:phantom")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
