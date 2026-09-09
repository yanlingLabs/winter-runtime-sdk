// WS-05 §9/§9.1 (D18): the layout, and the asymmetry between adopting and clone-copying.
import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { WINTER_BRAND, envName, resolveBrand } from "@yanlinglabs/winter-agent-sdk";

import {
  materializeTempContinuity,
  resolveEngineTempLayout,
  sessionTempDirFor,
  TempContinuityError,
  tempContinuityDisclosure,
  tempContinuityModeFor,
  VENDOR_ENGINE_DIR_PREFIX,
} from "../../src/store/index.ts";
import { withStoreBed } from "./support.ts";

const UID = 4242;
const KEYS = { tempProjectKey: "-lane-c-project", backendUuid: "11111111-2222-4333-8444-555555555555" };

function layoutIn(base: string, brand = WINTER_BRAND) {
  mkdirSync(base, { recursive: true });
  return resolveEngineTempLayout({ brand, ...KEYS, uid: UID, env: { [envName(brand, "TMPDIR")]: base } });
}

describe("D18's layout", () => {
  test("both engines are siblings under one shared per-user root, and only the vendor's name is a literal", async () => {
    await withStoreBed(async (bed) => {
      const layout = layoutIn(bed.tempBase);
      const base = realpathSync(bed.tempBase);
      expect(layout.base).toBe(base);
      expect(layout.sharedRoot).toBe(join(base, `${WINTER_BRAND.tempRootName}-${UID}`));
      expect(layout.winterEngineDir).toBe(join(layout.sharedRoot, `${WINTER_BRAND.tempRootName}-${UID}`));
      expect(layout.vendorEngineDir).toBe(join(layout.sharedRoot, `${VENDOR_ENGINE_DIR_PREFIX}${UID}`));
      expect(layout.winterSessionDir).toBe(join(layout.winterEngineDir, KEYS.tempProjectKey, KEYS.backendUuid));
      expect(layout.vendorSessionDir).toBe(join(layout.vendorEngineDir, KEYS.tempProjectKey, KEYS.backendUuid));
    });
  });

  test("every Winter-owned segment moves with the brand; the vendor's does not", async () => {
    await withStoreBed(async (bed) => {
      const resolved = resolveBrand({ tempRootName: "acme", envPrefix: "ACME_", packageName: "acme-agent-sdk", homeDirName: ".acme" });
      if (!resolved.ok) throw new Error(resolved.reason);
      const layout = layoutIn(join(bed.tempBase, "acme"), resolved.brand);
      expect(layout.sharedRoot.endsWith(`acme-${UID}`)).toBe(true);
      expect(layout.winterEngineDir.endsWith(join(`acme-${UID}`, `acme-${UID}`))).toBe(true);
      // The official engine hard-appends this beneath whatever temp root it is given. Rebranding it
      // would not rename a directory; it would name a directory that does not exist.
      expect(layout.vendorEngineDir.endsWith(`${VENDOR_ENGINE_DIR_PREFIX}${UID}`)).toBe(true);
    });
  });

  test("a temp base that does not resolve is a typed refusal, not a path built on a guess", () => {
    expect(() => resolveEngineTempLayout({ brand: WINTER_BRAND, ...KEYS, uid: UID, env: { [envName(WINTER_BRAND, "TMPDIR")]: "/nope/nope/nope" } })).toThrow(TempContinuityError);
  });
});

describe("§9.1's two directions", () => {
  test("the mode is decided by the DESTINATION, never by the source", () => {
    expect(tempContinuityModeFor("winter-agent")).toBe("adopt");
    expect(tempContinuityModeFor("claude-agent")).toBe("clone-copy");
  });

  test("Claude -> Winter ADOPTS the recorded vendor dir in place: no copy, same absolute paths", async () => {
    await withStoreBed(async (bed) => {
      const layout = layoutIn(bed.tempBase);
      mkdirSync(join(layout.vendorSessionDir, "scratchpad"), { recursive: true });
      writeFileSync(join(layout.vendorSessionDir, "scratchpad", "note.txt"), "recorded");

      const result = materializeTempContinuity({ to: "winter-agent", layout, recordedTempDir: layout.vendorSessionDir });
      expect(result.mode).toBe("adopt");
      expect(result.effectiveTempDir).toBe(layout.vendorSessionDir);
      expect(result.filesCopied).toBe(0);
      expect(result.supersededDir).toBeUndefined();
      // "transcript-recorded absolute paths stay live for read AND write"
      expect(readFileSync(join(result.effectiveTempDir, "scratchpad", "note.txt"), "utf8")).toBe("recorded");
      writeFileSync(join(result.effectiveTempDir, "scratchpad", "second.txt"), "written after the handoff");
      expect(tempContinuityDisclosure(layout, result).note).toContain("adopted in place");
    });
  });

  test("Winter -> Claude CLONE-COPIES into the path the vendor computes, and retains the superseded dir", async () => {
    await withStoreBed(async (bed) => {
      const layout = layoutIn(bed.tempBase);
      mkdirSync(join(layout.winterSessionDir, "scratchpad"), { recursive: true });
      writeFileSync(join(layout.winterSessionDir, "scratchpad", "note.txt"), "carried");
      mkdirSync(join(layout.winterSessionDir, "tasks"), { recursive: true });
      writeFileSync(join(layout.winterSessionDir, "tasks", "t1.output"), "output");
      symlinkSync("/etc/hosts", join(layout.winterSessionDir, "outside"));

      const result = materializeTempContinuity({ to: "claude-agent", layout, recordedTempDir: layout.winterSessionDir });
      expect(result.mode).toBe("clone-copy");
      expect(result.effectiveTempDir).toBe(layout.vendorSessionDir);
      expect(result.supersededDir).toBe(layout.winterSessionDir);
      expect(readFileSync(join(layout.vendorSessionDir, "scratchpad", "note.txt"), "utf8")).toBe("carried");
      // Symlinks are copied AS symlinks: following one would pull content from outside the tree.
      expect(lstatSync(join(layout.vendorSessionDir, "outside")).isSymbolicLink()).toBe(true);
      // The superseded dir is RETAINED and named — not chmod'ed, because retention still has to
      // be able to remove it.
      expect(readFileSync(join(layout.winterSessionDir, "scratchpad", "note.txt"), "utf8")).toBe("carried");
      expect(tempContinuityDisclosure(layout, result).supersededDir).toBe(layout.winterSessionDir);
      // WS-05 §9's modes, re-applied at the destination.
      expect(lstatSync(layout.vendorSessionDir).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(layout.vendorSessionDir, "scratchpad", "note.txt")).mode & 0o777).toBe(0o600);
    });
  });

  test("§9.1's round-trip row: once the session lives in the vendor dir, a later Claude leg copies nothing", async () => {
    await withStoreBed(async (bed) => {
      const layout = layoutIn(bed.tempBase);
      mkdirSync(join(layout.vendorSessionDir, "scratchpad"), { recursive: true });
      writeFileSync(join(layout.vendorSessionDir, "scratchpad", "note.txt"), "stable");
      const result = materializeTempContinuity({ to: "claude-agent", layout, recordedTempDir: layout.vendorSessionDir });
      expect(result.stabilized).toBe(true);
      expect(result.filesCopied).toBe(0);
      expect(result.effectiveTempDir).toBe(layout.vendorSessionDir);
      expect(readFileSync(join(layout.vendorSessionDir, "scratchpad", "note.txt"), "utf8")).toBe("stable");
      expect(tempContinuityDisclosure(layout, result).note).toContain("nothing was copied");
    });
  });

  test("§9.1's last row: a recorded dir that no longer exists is recreated at the owning engine's path", async () => {
    await withStoreBed(async (bed) => {
      const layout = layoutIn(bed.tempBase);
      const gone = join(layout.winterEngineDir, KEYS.tempProjectKey, "swept-away");
      for (const to of ["winter-agent", "claude-agent"] as const) {
        const result = materializeTempContinuity({ to, layout, recordedTempDir: gone });
        expect(result.recreated).toBe(true);
        expect(result.effectiveTempDir).toBe(sessionTempDirFor(to, layout));
        expect(lstatSync(result.effectiveTempDir).isDirectory()).toBe(true);
      }
    });
  });

  test("a recorded dir outside the session's shared root is refused rather than copied", async () => {
    await withStoreBed(async (bed) => {
      const layout = layoutIn(bed.tempBase);
      const elsewhere = join(bed.home, "somewhere-else");
      mkdirSync(elsewhere, { recursive: true });
      expect(() => materializeTempContinuity({ to: "claude-agent", layout, recordedTempDir: elsewhere })).toThrow(TempContinuityError);
      expect(() => materializeTempContinuity({ to: "winter-agent", layout, recordedTempDir: elsewhere })).toThrow(TempContinuityError);
    });
  });

  test("a symlink standing where a session dir belongs is refused, never followed", async () => {
    await withStoreBed(async (bed) => {
      const layout = layoutIn(bed.tempBase);
      mkdirSync(join(layout.vendorEngineDir, KEYS.tempProjectKey), { recursive: true });
      const target = join(bed.home, "attacker");
      mkdirSync(target, { recursive: true });
      symlinkSync(target, layout.vendorSessionDir);
      mkdirSync(layout.winterSessionDir, { recursive: true });
      expect(() => materializeTempContinuity({ to: "claude-agent", layout, recordedTempDir: layout.winterSessionDir })).toThrow(TempContinuityError);
    });
  });

  test("a session dir owned by another uid is refused", async () => {
    await withStoreBed(async (bed) => {
      const layout = layoutIn(bed.tempBase);
      mkdirSync(layout.winterSessionDir, { recursive: true });
      // Ownership cannot be forged in a test without privileges, so this asserts the mode half of the
      // same validation: a 0700 self-heal happens on every materialization.
      mkdirSync(layout.vendorSessionDir, { recursive: true, mode: 0o777 });
      chmodSync(layout.vendorSessionDir, 0o777);
      materializeTempContinuity({ to: "claude-agent", layout, recordedTempDir: layout.winterSessionDir });
      expect(lstatSync(layout.vendorSessionDir).mode & 0o777).toBe(0o700);
    });
  });
});
