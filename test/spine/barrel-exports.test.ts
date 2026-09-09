// NO NAME IS EXPORTED BY TWO LANE BARRELS — the gate review r4's N13 asked for, and the reason it is
// a gate rather than a sweep.
//
// FOUR LANES BUILT THIS PACKAGE IN FOUR TREES AT THE SAME TIME. None of them could import another's
// files (they did not exist yet), so when two lanes needed the same thing they each wrote it — and
// then each exported it from its own `src/<lane>/index.ts`. That produced two `resumeStagingRoot`s
// with MIRRORED ARGUMENT ORDERS and two `acceptNativeSendMessageArgs` that had already drifted on
// what `to` may contain. Neither showed up in any lane's tests, because each lane's tests import
// their OWN lane's barrel and both copies were individually correct there.
//
// WHY A NAME COLLISION IS THE RIGHT TRIPWIRE. It is not about tidiness: two exports of one name are
// two implementations of one contract, and the failure mode is a caller importing the other one.
// With `resumeStagingRoot(tmpdir, uuid)` against `resumeStagingRoot(uuid, base)` the wrong import
// type-checks (both parameters are `string`), runs, and produces a directory that exists and that no
// runtime will ever write to. A collision is cheap to detect and expensive to find later, which is
// exactly the shape a gate is for.
//
// THE SCAN IS LEXICAL, over each barrel's own AST — `export { … } from`, `export type { … } from`,
// and every exported declaration. It is deliberately NOT a type-checker run: a barrel is a list of
// names and this test is about that list, so it costs milliseconds and cannot be affected by
// whatever else in the tree happens to compile. `export *` is REFUSED rather than resolved, because a
// star re-export in a lane barrel would make the list unknowable without a checker — and the package
// barrel (`src/index.ts`, which does star-export the Winter SDK) is not a lane barrel and is not
// scanned here. `test/spine/contract-reexport.test.ts` is what covers that one.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(REPO_ROOT, "src");

/** Every `src/<dir>/index.ts` — the lane barrels, whatever a future lane adds. */
export function laneBarrels(): string[] {
  return readdirSync(SRC)
    .filter((entry) => statSync(join(SRC, entry)).isDirectory())
    .map((entry) => join(SRC, entry, "index.ts"))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

export interface BarrelExports {
  names: string[];
  /** A `export * from "…"` this scan cannot enumerate. Its presence fails the test by itself. */
  stars: string[];
}

/** The names one barrel exports — values and types alike, since a duplicate type drifts the same way. */
export function exportedNames(source: string, fileName: string): BarrelExports {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const stars: string[] = [];
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined) {
        stars.push(statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "<unknown>");
        continue;
      }
      if (ts.isNamedExports(clause)) for (const element of clause.elements) names.push(element.name.text);
      else stars.push(clause.name.text); // `export * as ns from …` — one name, but still opaque
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      names.push(statement.name.text);
    }
  }
  return { names, stars };
}

describe("the lane barrels", () => {
  const barrels = laneBarrels();
  const scanned = barrels.map((path) => ({ path, relative: path.slice(REPO_ROOT.length + 1), ...exportedNames(readFileSync(path, "utf8"), path) }));

  test("there is more than one of them, so the check is not vacuous", () => {
    expect(barrels.length).toBeGreaterThan(1);
    // Every barrel exports SOMETHING — a parse that silently returned nothing would pass everything.
    for (const barrel of scanned) expect(barrel.names.length).toBeGreaterThan(0);
  });

  test("none of them re-exports with a star, so the name list is knowable without a type-checker", () => {
    for (const barrel of scanned) expect({ file: barrel.relative, stars: barrel.stars }).toEqual({ file: barrel.relative, stars: [] });
  });

  test("no name is exported by two of them", () => {
    const owners = new Map<string, string[]>();
    for (const barrel of scanned) for (const name of barrel.names) owners.set(name, [...(owners.get(name) ?? []), barrel.relative]);
    const collisions = [...owners].filter(([, files]) => files.length > 1).map(([name, files]) => `${name}: ${files.join(" + ")}`);
    expect(collisions).toEqual([]);
  });

  test("a barrel does not export the same name twice itself", () => {
    for (const barrel of scanned) {
      const seen = new Set<string>();
      const repeats = barrel.names.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
      expect({ file: barrel.relative, repeats }).toEqual({ file: barrel.relative, repeats: [] });
    }
  });
});

describe("the two shared modules neither lane owns", () => {
  // The names N13 unified. They are on the PACKAGE barrel and on no lane barrel — which is the state
  // the collision gate above keeps, but stated positively so a future edit that moved one back into a
  // lane (and out of the public surface) fails here rather than silently shrinking the package.
  const SHARED = {
    "vendor-paths.ts": ["RESUME_STAGING_PREFIX", "isResumeStagingRoot", "resumeStagingRoot"],
    "native-args.ts": ["acceptNativeListAgentsArgs", "acceptNativeSendMessageArgs", "NATIVE_SEND_MESSAGE_SCHEMA", "NATIVE_LIST_AGENTS_SCHEMA", "NATIVE_LIST_AGENTS_OUTPUT_SCHEMA", "SEND_MESSAGE_TO_MAX", "SEND_MESSAGE_SUMMARY_MAX", "LIST_AGENTS_FIELD_MAX"],
  } as const;
  const all = Object.values(SHARED).flat() as readonly string[];

  test("every shared name is on the package barrel, exactly once", async () => {
    const barrel = (await import("../../src/index.ts")) as Record<string, unknown>;
    for (const name of all) expect({ name, present: name in barrel }).toEqual({ name, present: true });
    const source = readFileSync(join(SRC, "index.ts"), "utf8");
    const { names } = exportedNames(source, join(SRC, "index.ts"));
    for (const name of all) expect({ name, times: names.filter((candidate) => candidate === name).length }).toEqual({ name, times: 1 });
  });

  test("and on no lane barrel", () => {
    const shared = new Set<string>(all);
    for (const barrel of laneBarrels().map((path) => ({ relative: path.slice(REPO_ROOT.length + 1), ...exportedNames(readFileSync(path, "utf8"), path) }))) {
      expect({ file: barrel.relative, leaked: barrel.names.filter((name) => shared.has(name)) }).toEqual({ file: barrel.relative, leaked: [] });
    }
  });

  test("one definition means one identity: both lanes' importers see the SAME function object", async () => {
    // The real hazard N13 named was two functions with mirrored argument orders. Identity is the only
    // assertion that cannot be satisfied by a second copy that merely looks the same today.
    const shared = await import("../../src/vendor-paths.ts");
    const spool = await import("../../src/official/spool.ts");
    const store = await import("../../src/store/materialized-resume.ts");
    expect(Object.keys(spool)).not.toContain("resumeStagingRoot");
    expect(Object.keys(store)).not.toContain("resumeStagingRoot");
    const aliases = (await import("../../src/official/aliases.ts")) as Record<string, unknown>;
    const nativeArgs = (await import("../../src/native-args.ts")) as Record<string, unknown>;
    expect(aliases["acceptNativeSendMessageArgs"]).toBe(nativeArgs["acceptNativeSendMessageArgs"]);
    const messaging = (await import("../../src/messaging/handlers.ts")) as Record<string, unknown>;
    expect(messaging["acceptNativeSendMessageArgs"]).toBeUndefined();
    // …and the one surviving argument order is `(uuid, base)`, not the mirrored one.
    expect(shared.resumeStagingRoot("u", "/tmp")).toBe(`/tmp/${shared.RESUME_STAGING_PREFIX}u`);
  });
});
