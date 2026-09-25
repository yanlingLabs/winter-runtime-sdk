// WS-21 §3.1, §3.3, §3.4.6: the run folder itself — where it lives, what it links, what it never makes.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildRunHome, RUN_HOME_PERSISTENT_ENTRIES, RunHomeError } from "../../src/index.ts";
import { cleanupRunHomeBeds, inputFor, runHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("the run folder", () => {
  test("is <home>/cache/runs/<uuid>, mode 0700, and names its shared home", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    expect(runHome.runId).toMatch(UUID_RE);
    expect(runHome.dir).toBe(join(bed.home, "cache", "runs", runHome.runId));
    expect(runHome.sdkHome).toBe(bed.sdk);
    expect(statSync(runHome.dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(runHome.dir).isDirectory()).toBe(true);
  });

  test("two builds are two folders", async () => {
    const bed = runHomeBed();
    const a = await buildRunHome(inputFor(bed));
    const b = await buildRunHome(inputFor(bed));
    expect(a.runId).not.toBe(b.runId);
    expect(a.dir).not.toBe(b.dir);
  });

  test("is refused, typed, when `cache` is a link — nothing is created through it", async () => {
    const bed = runHomeBed();
    const elsewhere = join(bed.root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(bed.home, "cache"));
    const error = await buildRunHome(inputFor(bed)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RunHomeError);
    expect((error as RunHomeError).code).toBe("run_home_link_refused");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("is refused, typed, when `cache/runs` is a link", async () => {
    const bed = runHomeBed();
    const elsewhere = join(bed.root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(bed.home, "cache"));
    symlinkSync(elsewhere, join(bed.home, "cache", "runs"));
    const error = await buildRunHome(inputFor(bed)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as RunHomeError).code).toBe("run_home_link_refused");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("refuses an input that is not absolute where it must be", async () => {
    const bed = runHomeBed();
    await expect(buildRunHome(inputFor(bed, { home: "relative/home" }))).rejects.toThrow();
    await expect(buildRunHome(inputFor(bed, { cwd: "relative" }))).rejects.toThrow();
    await expect(buildRunHome(inputFor(bed, { memoryDir: "memory" }))).rejects.toThrow();
  });
});

describe("the persistent set", () => {
  test("is pre-created in sdk/ and appears in the run folder as links to it", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    for (const entry of RUN_HOME_PERSISTENT_ENTRIES) {
      expect(lstatSync(join(bed.sdk, entry)).isDirectory()).toBe(true);
      const link = join(runHome.dir, entry);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(join(bed.sdk, entry));
    }
  });

  test("an existing sdk/ entry is kept, not replaced", async () => {
    const bed = runHomeBed();
    mkdirSync(join(bed.sdk, "tasks"), { recursive: true });
    writeFileSync(join(bed.sdk, "tasks", "keep.json"), "{}");
    await buildRunHome(inputFor(bed));
    expect(readFileSync(join(bed.sdk, "tasks", "keep.json"), "utf8")).toBe("{}");
  });

  test("outlives dispose(): what a runtime wrote through the link is still in sdk/", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    writeFileSync(join(runHome.dir, "tasks", "t.json"), "task");
    await runHome.dispose();
    expect(existsSync(runHome.dir)).toBe(false);
    expect(readFileSync(join(bed.sdk, "tasks", "t.json"), "utf8")).toBe("task");
    for (const entry of RUN_HOME_PERSISTENT_ENTRIES) expect(existsSync(join(bed.sdk, entry))).toBe(true);
  });

  test("dispose() is idempotent", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    await runHome.dispose();
    await runHome.dispose();
    expect(existsSync(runHome.dir)).toBe(false);
  });
});

describe("projects/, backups/ and the rest of sdk/", () => {
  test("Winter leg: projects is a link to sdk/projects (the Winter child writes the canonical store)", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed, { leg: "winter" }));
    const link = join(runHome.dir, "projects");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(bed.sdk, "projects"));
    expect(lstatSync(join(bed.sdk, "projects")).isDirectory()).toBe(true);
  });

  test("WS-23: a run home for the retired official leg is refused typed, and nothing is built", async () => {
    const bed = runHomeBed();
    await expect(buildRunHome(inputFor(bed, { leg: "official" as "winter" }))).rejects.toThrow(/official leg is retired/);
    expect(existsSync(join(bed.home, "cache", "runs")) ? readdirSync(join(bed.home, "cache", "runs")) : []).toEqual([]);
  });

  test("backups/ is never created, and sdk/plugins is never linked (the plugin root is an env var)", async () => {
    const bed = runHomeBed();
    mkdirSync(join(bed.sdk, "plugins"), { recursive: true });
    mkdirSync(join(bed.sdk, "backups"), { recursive: true });
    const runHome = await buildRunHome(inputFor(bed, { leg: "winter" }));
    const names = readdirSync(runHome.dir);
    expect(names).not.toContain("backups");
    expect(names).not.toContain("plugins");
  });

  test("nothing else in sdk/ is linked in by the core (history, sessions, caches stay out)", async () => {
    const bed = runHomeBed();
    for (const name of ["history.jsonl", "cache", "sessions", "shell-snapshots"]) {
      if (name.includes(".")) {
        mkdirSync(bed.sdk, { recursive: true });
        writeFileSync(join(bed.sdk, name), "x");
      } else mkdirSync(join(bed.sdk, name), { recursive: true });
    }
    const runHome = await buildRunHome(inputFor(bed));
    const names = readdirSync(runHome.dir);
    for (const name of ["history.jsonl", "cache", "sessions", "shell-snapshots"]) expect(names).not.toContain(name);
  });
});
