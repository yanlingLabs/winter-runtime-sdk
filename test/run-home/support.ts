// Shared beds for the run-home tests: a throwaway daemon home per test, never `~/.winter*`.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RunHomeInput } from "../../src/run-home/types.ts";

const roots: string[] = [];

export interface RunHomeBed {
  /** The temp root everything lives under. Real path (no `/var` → `/private/var` link in it). */
  root: string;
  /** The daemon home (`WINTER_HOME`). */
  home: string;
  /** `<home>/sdk`. */
  sdk: string;
  /** A working directory that is not a project. */
  cwd: string;
}

/** A fresh temp daemon home. Real paths, so assertions compare the strings the builder writes. */
export function runHomeBed(prefix = "rh"): RunHomeBed {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `winter-rt-${prefix}-`)));
  roots.push(root);
  const home = join(root, "home");
  const sdk = join(home, "sdk");
  const cwd = join(root, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { root, home, sdk, cwd };
}

export function cleanupRunHomeBeds(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** A complete input with every field defaulted to the least-privileged value. */
export function inputFor(bed: RunHomeBed, overrides: Partial<RunHomeInput> = {}): RunHomeInput {
  return {
    home: bed.home,
    mode: "code",
    dispatchChild: false,
    leg: "winter",
    cwd: bed.cwd,
    trustedProjectRoot: null,
    gitRoot: null,
    mcpDisabled: [],
    reservedMcpServerNames: [],
    memoryDir: join(bed.sdk, "projects", "k", "memory"),
    ...overrides,
  };
}

/** Writes a file, creating its directory. */
export function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
