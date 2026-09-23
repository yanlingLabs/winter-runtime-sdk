// WS-21 §7.2, measured on the pinned runtime: the protected-path `permissions.ask` rules the router pins
// in the flag layer, spelled with `fsRootAnchored` (`//abs/path`), really FIRE.
//
// Under `acceptEdits` the runtime approves a write inside the cwd without ever calling `canUseTool`
// (F16) — the CONTROL shows that for an unprotected file. The trusted project's `.winter/` is not on the
// runtime's own protected list either, so without the router's ask rule a write to
// `<root>/.winter/skills/x/SKILL.md` would be approved the same way. With it, the request reaches
// `canUseTool` — which is the proof that the spelling matches what the runtime compares.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";

import { cleanupHermetic, hermeticEnvPolicy, hermeticSession, officialRuntimeBed, scriptedLoopback } from "./support.ts";
import { createInMemoryRuntimeDirectoryStore, createOfficialInputStream, protectedPathRules } from "../../src/index.ts";
import { createOfficialAdapter } from "../../src/official/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import type { OfficialQuery } from "../../src/seams/official-sdk-shapes.ts";
import { stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import { drainAll, withWs21Bed, WS21_TIMEOUT } from "../run-home/official-bed.ts";

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;

const bed = officialRuntimeBed();

describeRuntime("WS-21 §7.2 — the protected-path ask rule fires on the pinned runtime", () => {
  afterAll(cleanupHermetic);

  test(
    "C1: cwd AT the root, a Write to a DEEPER directory's .winter/skills reaches canUseTool under acceptEdits (the any-depth rule); an unprotected sibling does not",
    async () => {
      const session = hermeticSession("protected-deep", { compact: true });
      const root = session.cwd;
      // `packages/app` shape, in one-letter segments (the pin's 64-character transcript-key cap).
      const deep = join(root, "p", "a");
      mkdirSync(deep, { recursive: true });
      const control = join(deep, "notes.txt");
      const protectedFile = join(deep, ".winter", "skills", "x", "SKILL.md");
      const asked: Array<{ tool: string; path: unknown }> = [];
      await withWs21Bed(
        {
          reuse: session,
          turns: [
            { toolUses: [{ id: "toolu_control", name: "Write", input: { file_path: control, content: "control\n" } }] },
            { toolUses: [{ id: "toolu_protected", name: "Write", input: { file_path: protectedFile, content: "---\nname: x\ndescription: x\nallowed-tools: Bash\n---\n" } }] },
            { text: "done" },
          ],
        },
        async (bed) => {
          const runHome = await bed.runHome({ cwd: root, trustedProjectRoot: root, gitRoot: root });
          const options = bed.options(runHome, {
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              asked.push({ tool: toolName, path: input["file_path"] });
              return { behavior: "deny", message: "the test broker records and denies" };
            },
          });
          const input = createOfficialInputStream();
          const handle = bed.sdk.query({ prompt: input, options }) as unknown as OfficialQuery & AsyncIterable<Record<string, unknown>>;
          await handle.setPermissionMode("acceptEdits");
          const done = (async () => {
            for await (const message of handle) if (message["type"] === "result") input.close();
          })();
          await input.push("write the two files");
          await done;
        },
      );
      const same = (a: unknown, b: string): boolean => typeof a === "string" && (a === b || a === join(realpathSync(root), b.slice(root.length)));
      expect(existsSync(control)).toBe(true);
      expect(asked.some((entry) => same(entry.path, control))).toBe(false);
      expect(asked.some((entry) => entry.tool === "Write" && same(entry.path, protectedFile))).toBe(true);
      expect(existsSync(protectedFile)).toBe(false);
    },
    WS21_TIMEOUT,
  );

  test(
    "C1 under bypassPermissions, on the pin directly: the router's own rules still reach canUseTool at depth 0 and at depth 2 (the router refuses bypass on its own leg; this is the defence-in-depth measurement)",
    async () => {
      /* c8 ignore next */
      if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
      const session = hermeticSession("protected-bypass", { compact: true });
      const root = session.cwd;
      const deep = join(root, "p", "a");
      mkdirSync(deep, { recursive: true });
      const control = join(deep, "notes.txt");
      const atRoot = join(root, ".winter", "rules", "r.md");
      const deeper = join(deep, ".winter", "commands", "c.md");
      const { routes } = scriptedLoopback([
        { toolUses: [{ id: "toolu_control", name: "Write", input: { file_path: control, content: "control\n" } }] },
        { toolUses: [{ id: "toolu_root", name: "Write", input: { file_path: atRoot, content: "rule\n" } }] },
        { toolUses: [{ id: "toolu_deep", name: "Write", input: { file_path: deeper, content: "command\n" } }] },
        { text: "done" },
      ]);
      // EXACTLY what the router pins, for both spellings of the root (the runtime compares the resolved path).
      const rules = [...protectedPathRules(join(session.brandHome, "sdk"), root), ...protectedPathRules(join(realpathSync(session.brandHome), "sdk"), realpathSync(root))];
      const asked: string[] = [];
      await withLoopbackFake({ routes }, async (fake) => {
        const selection: RuntimeSelection = { runtimeKind: "claude-agent", providerId: "loopback", modelRef: "claude-sonnet-4-5", family: "claude", authFamily: "custom", sdkVersion: "0.0.2", reason: "the bypass measurement", decidedAt: new Date(0).toISOString() };
        const base = { peers: { winter: createFakeWinterPeer().peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore: createInMemoryRuntimeDirectoryStore() };
        const context: SeamContextWithDirectory = { ...base, directory: stubRuntimeDirectory(base) };
        const env = createOfficialAdapter(context, hermeticEnvPolicy()).buildChildEnv({
          selection,
          configDir: session.spool,
          brand: WINTER_BRAND,
          credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
          base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        });
        const query = bed.module.query({
          prompt: "write the three files",
          options: {
            cwd: root,
            env,
            pathToClaudeCodeExecutable: bed.executable,
            settingSources: [],
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            settings: { permissions: { ask: rules } },
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              asked.push(String(input["file_path"]));
              return { behavior: "deny", message: "the test broker records and denies" };
            },
          } as never,
        }) as AsyncIterable<unknown>;
        for await (const message of query) void message;
      });
      const same = (a: string, b: string): boolean => a === b || a === join(realpathSync(root), b.slice(root.length));
      // CONTROL: bypass writes the unprotected file without asking.
      expect(existsSync(control)).toBe(true);
      expect(asked.some((path) => same(path, control))).toBe(false);
      // Both protected writes were asked — the root's own `.winter/` (`**` = zero dirs) and a deeper one.
      for (const target of [atRoot, deeper]) {
        expect([target, asked.some((path) => same(path, target))]).toEqual([target, true]);
        expect([target, existsSync(target)]).toEqual([target, false]);
      }
    },
    WS21_TIMEOUT,
  );

  test(
    "fix round 1, I2: a NESTED project dir between the cwd and the root is protected too (cwd <root>/p writes <root>/p/.winter/skills/x/SKILL.md)",
    async () => {
      const session = hermeticSession("protected-nested", { compact: true });
      const root = session.cwd;
      // A one-letter segment: the transcript key derived from the cwd must fit the pin's 64 characters.
      const cwd = join(root, "p");
      mkdirSync(cwd, { recursive: true });
      const control = join(cwd, "notes.txt");
      const protectedFile = join(cwd, ".winter", "skills", "x", "SKILL.md");
      const asked: Array<{ tool: string; path: unknown }> = [];
      await withWs21Bed(
        {
          reuse: session,
          turns: [
            { toolUses: [{ id: "toolu_control", name: "Write", input: { file_path: control, content: "control\n" } }] },
            { toolUses: [{ id: "toolu_protected", name: "Write", input: { file_path: protectedFile, content: "---\nname: x\ndescription: x\n---\n" } }] },
            { text: "done" },
          ],
        },
        async (bed) => {
          const runHome = await bed.runHome({ cwd, trustedProjectRoot: root, gitRoot: root });
          const options = bed.options(runHome, {
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              asked.push({ tool: toolName, path: input["file_path"] });
              return { behavior: "deny", message: "the test broker records and denies" };
            },
          });
          (options as { cwd: string }).cwd = cwd;
          const input = createOfficialInputStream();
          const handle = bed.sdk.query({ prompt: input, options }) as unknown as OfficialQuery & AsyncIterable<Record<string, unknown>>;
          await handle.setPermissionMode("acceptEdits");
          const done = (async () => {
            for await (const message of handle) if (message["type"] === "result") input.close();
          })();
          await input.push("write the two files");
          await done;
        },
      );
      const same = (a: unknown, b: string): boolean => typeof a === "string" && (a === b || a === join(realpathSync(root), b.slice(root.length)));
      expect(existsSync(control)).toBe(true);
      expect(asked.some((entry) => same(entry.path, control))).toBe(false);
      expect(asked.some((entry) => entry.tool === "Write" && same(entry.path, protectedFile))).toBe(true);
      expect(existsSync(protectedFile)).toBe(false);
    },
    WS21_TIMEOUT,
  );

  test(
    "under acceptEdits: an unprotected in-cwd Write is auto-approved (control); a Write to the trusted project's .winter/skills reaches canUseTool",
    async () => {
      const session = hermeticSession("protected", { compact: true });
      // THE GIVEN SPELLING, deliberately: on macOS the temp root is reached through `/var` → `/private/var`,
      // and the runtime compares rules against the path it RESOLVED — the binding's rules cover both.
      const cwd = session.cwd;
      const control = join(cwd, "notes.txt");
      const protectedFile = join(cwd, ".winter", "skills", "x", "SKILL.md");
      const asked: Array<{ tool: string; path: unknown }> = [];
      await withWs21Bed(
        {
          reuse: session,
          turns: [
            { toolUses: [{ id: "toolu_control", name: "Write", input: { file_path: control, content: "control\n" } }] },
            { toolUses: [{ id: "toolu_protected", name: "Write", input: { file_path: protectedFile, content: "---\nname: x\ndescription: x\n---\n" } }] },
            { text: "done" },
          ],
        },
        async (bed) => {
          const runHome = await bed.runHome({ cwd, trustedProjectRoot: cwd, gitRoot: cwd });
          const options = bed.options(runHome, {
            permissionMode: "acceptEdits",
            canUseTool: async (toolName: string, input: Record<string, unknown>) => {
              asked.push({ tool: toolName, path: input["file_path"] });
              return { behavior: "deny", message: "the test broker records and denies" };
            },
          });
          (options as { cwd: string }).cwd = cwd;
          // THE MODE IS SET LIVE (the pin's own control request): the launch path does not forward
          // `Options.permissionMode` to the child (a pre-existing gap, reported), and a live switch is
          // the path a host's policy change takes anyway.
          const input = createOfficialInputStream();
          const handle = bed.sdk.query({ prompt: input, options }) as unknown as OfficialQuery & AsyncIterable<Record<string, unknown>>;
          await handle.setPermissionMode("acceptEdits");
          const done = (async () => {
            for await (const message of handle) if (message["type"] === "result") input.close();
          })();
          await input.push("write the two files");
          await done;
          void drainAll;
        },
      );
      const same = (a: unknown, b: string): boolean => typeof a === "string" && (a === b || a === join(realpathSync(cwd), b.slice(cwd.length)));
      // CONTROL: the unprotected file was written, and the broker was never asked about it.
      expect(existsSync(control)).toBe(true);
      expect(asked.some((entry) => same(entry.path, control))).toBe(false);
      // THE RULE FIRED: the protected write reached `canUseTool` and, denied there, was never written.
      expect(asked.some((entry) => entry.tool === "Write" && same(entry.path, protectedFile))).toBe(true);
      expect(existsSync(protectedFile)).toBe(false);
    },
    WS21_TIMEOUT,
  );
});
