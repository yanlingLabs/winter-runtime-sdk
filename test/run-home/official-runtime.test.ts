// WS-21 against the REAL pinned runtime: a fresh generation runs IN its run folder under the user
// source, and a store-backed resume runs on the wrapper's staging dir with the run folder linked in —
// and the transcript mirror still reaches the canonical file in the shared runtime home.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeSdkInternals } from "../../src/index.ts";
import type { SharedSessionStore } from "../../src/store/wiring.ts";

import { cleanupHermetic, decoyUntouched, officialRuntimeBed } from "../official/support.ts";
import { drainAll, withWs21Bed, WS21_TIMEOUT } from "./official-bed.ts";
import { put } from "./support.ts";

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;

describeRuntime("WS-21 on the pinned runtime", () => {
  afterAll(cleanupHermetic);

  test(
    "a fresh generation reads its run folder (user source): the shared home's instructions and a user skill reach it",
    async () => {
      await withWs21Bed({ turns: [{ text: "ok" }] }, async (bed) => {
        put(join(bed.sdkHome, "WINTER.md"), "Always mention USER-INSTRUCTIONS-TOKEN-9d1e.\n");
        put(join(bed.sdkHome, "skills", "user-skill", "SKILL.md"), "---\nname: user-skill\ndescription: a user skill\n---\n\nok\n");
        const runHome = await bed.runHome();
        const messages = await drainAll(bed.sdk.query({ prompt: "hi", options: bed.options(runHome) }));
        const init = messages.find((message) => message["type"] === "system" && message["subtype"] === "init") as { skills?: string[] } | undefined;
        expect(init?.skills).toContain("user-skill");
        expect(JSON.stringify(bed.record.requests)).toContain("USER-INSTRUCTIONS-TOKEN-9d1e");
        expect(decoyUntouched(bed.session)).toBe(true);
      });
    },
    WS21_TIMEOUT,
  );

  test(
    "a store-backed resume: configured on `<run>/.absent` (never created), run on the staging dir, mirrored into sdk/projects",
    async () => {
      await withWs21Bed({ turns: [{ text: "first answer" }] }, async (bed) => {
        const first = await bed.runHome();
        const firstMessages = await drainAll(bed.sdk.query({ prompt: "FIRST-PROMPT-7a2c", options: bed.options(first, { winterSessionId: "s_resume_1" }) }));
        const backend = String(firstMessages.find((message) => message["type"] === "system" && message["subtype"] === "init")?.["session_id"]);
        // The mirror batches (~100 ms): settle the router's own store before reading the file.
        const shared = (runtimeSdkInternals(bed.sdk)!.barrier as unknown as { shared: SharedSessionStore }).shared;
        await shared.settle();
        const canonical = join(bed.sdkHome, "projects", bed.projectKey, `${backend}.jsonl`);
        expect(existsSync(canonical)).toBe(true);
        expect(readFileSync(canonical, "utf8")).toContain("FIRST-PROMPT-7a2c");

        const second = await bed.runHome();
        await drainAll(bed.sdk.query({ prompt: "SECOND-PROMPT-51f0", options: bed.options(second, { sessionId: backend, winterSessionId: "s_resume_2" }) }));
        await shared.settle();
        // The resumed child saw the first turn: the wrapper staged it from the store.
        const last = JSON.stringify(bed.record.requests.at(-1));
        expect(last).toContain("FIRST-PROMPT-7a2c");
        expect(last).toContain("SECOND-PROMPT-51f0");
        // The placeholder was never created, and the mirror reached the canonical file.
        expect(existsSync(join(second.dir, ".absent"))).toBe(false);
        expect(readFileSync(canonical, "utf8")).toContain("SECOND-PROMPT-51f0");
        // A fresh home has no compatibility links: nothing was written to <home>/projects.
        expect(existsSync(join(bed.home, "projects"))).toBe(false);
        expect(decoyUntouched(bed.session)).toBe(true);
      });
    },
    WS21_TIMEOUT,
  );
});
