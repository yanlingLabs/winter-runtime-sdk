// Cascade tests for the guided compile packet's intake pin (scripts/guest-guided-intake/compile-<run>.pin.json).
// Each pin records what one compile run produced and what the audit found (run 39165162201, the first, whose providerWorker and
// hostClient are placeholders; run 39227365159, the second, whose roles are the real entries). These tests cannot download the
// artifact (CI has no access to it), so they pin the AGREEMENTS: the pin against the builder's input pin file, the
// artifact inventory against the builder's promise, the builder-origin bytes against the committed files, and the
// placeholder flags that stop anyone binding a hosted run to the two adapters. `pinViolations()` is a pure function
// of the pin; the mutation table feeds it one deliberately broken pin per check and requires each to be caught by its
// own named violation. A local audit of the real archive against this pin is quoted in the PR; verify_packet.py repeats it.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const INTAKE = "scripts/guest-guided-intake";
const BUILD = "scripts/guest-guided-build";
const ROLES = ["runtimeEntry", "providerWorker", "hostClient", "instructionReader"];
const NATIVES = ["toolLauncher", "runtimeLauncher", "fileWorker", "processWorker", "ownerLibrary", "instructionReaderLauncher"];
const PLACEHOLDERS = ["hostClient", "providerWorker"];
const STANDING_LINE = "if an automated safety flag fires on follow-on work, that work stops and is surfaced to the owner, never reworded or rerouted.";
const hex = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");

type Ent = { sha256: string; bytes: number };
type Pin = {
  kind: string; formatVersion: number;
  run: { id: number; attempt: number; event: string; conclusion: string; branch: string; armingCommit: string; createdAt: string };
  artifact: { id: number; name: string; zipSha256: string; zipBytes: number; expiresAt: string; members: string[] };
  archive: Ent; inventory: Ent & { fileCount: number; fileBytes: number };
  receipt: Ent & { path: string }; inputs: Ent & { path: string }; compilerAcquisition: Ent & { path: string };
  builder: { head: string; tree: string; files: Record<string, string> };
  workflowHead: string;
  origins: Record<string, { repository: string; head: string; tree: string; inventorySha256: string; fileCount: number }>;
  bun: { version: string; target: string; archiveSha256: string; executableSha256: string; stageBase: Ent & { path: string } };
  dependencies: { listSha256: string; packages: number; storeEntries: number; storeSha256: string; links: number };
  actions: Record<string, string>;
  artifacts: { roles: Record<string, Ent & { placeholder?: boolean }>; natives: Record<string, Ent> };
  metafiles: Record<string, Ent>; environment: Record<string, Ent>;
  resolverBindings: Record<string, string>;
  archiveRules: { regularFileMode: string; symlinkMode: string };
  symlinks: { total: number; resolverAliases: number; dependencyLinks: number };
  flags: Record<string, boolean>;
  binding: { bindable: string[]; notBindable: string[]; reason: string };
  continuity?: { previousRun: number; identicalToPreviousRun: string[]; changedFromPreviousRun: string[]; note: string };
};
type Inputs = {
  bun: { version: string; target: string; archiveSha256: string; executableSha256: string };
  origins: { agentSdk: { head: string; tree: string; repository: string }; runtimeSdk: { head: string; tree: string; repository: string }; winterCore: { head: string; tree: string; repository: string } };
  dependencies: { packages: unknown[]; aliases: Record<string, Record<string, string>> };
  actions: Record<string, string>; retentionDays: number; limits: { packetBytes: number; packetEntries: number };
};
export interface Context { inputs: Inputs; dependencyListSha256: string; pinsPy: string; files: (path: string) => string | null; workflow: string; limits: { packetBytes: number } }

/** Builder files the real-entries change superseded AFTER run 39165162201: they are historical records of what that run
 * compiled (the compile-only adapters, the run-1 trigger branch), checked at that run's builder head, not against the
 * working tree. Everything else the run pinned (the build logic, the dependency list, the reader helpers) must still
 * match, so an edit to the logic that produced the artifact still fails here. */
export const SUPERSEDED_BUILDER_FILES = [`${BUILD}/README.md`, `${BUILD}/entries/host-client.ts`, `${BUILD}/entries/provider-worker.ts`, `${BUILD}/guided-compile-inputs.pin.json`, `${BUILD}/pins.py`, `${BUILD}/test_guided_build.py`] as const;

/** Run 1's record of its three origins. It is a historical fact about that run, so it is held to these literals and NOT to the
 * current builder inputs, which move on (the runtime-sdk origin moved to the real entries; the agent-sdk origin will follow). */
const RUN1_ORIGINS: Record<string, { repository: string; head: string; tree: string }> = {
  sdk: { repository: "yanlingLabs/winter-agent-sdk", head: "68e57c646f23feba09b00c78d05d8c80d6f2962d", tree: "86dcb48155e40f6b084e8b0ffea529679b5274c2" },
  runtime: { repository: "yanlingLabs/winter-runtime-sdk", head: "29eede4b3e085044f5ed6bc6cf99e8f6c4daf6a1", tree: "5eba2966b84ee23ddcd76298cc58427c97095277" },
  winter: { repository: "yanlingLabs/winter", head: "8b52ef83d1ba721a4dd80cdbb205c617f8656555", tree: "703ad5263ef0a249e9666faa1eaf18a0f19c8be1" },
};

/** Run 2's record of its three origins (held to literals for the same reason as run 1's). */
const RUN2_ORIGINS: Record<string, { repository: string; head: string; tree: string }> = {
  sdk: { repository: "yanlingLabs/winter-agent-sdk", head: "9c980c326638489e0183d7fcddcf1a93553be0ba", tree: "e203a8d838369ca10586ac031dcdeef7bb0b2c69" },
  runtime: { repository: "yanlingLabs/winter-runtime-sdk", head: "ce730190854fd807446ac3a229a358c553a57697", tree: "b1166e6cc45f6445e8c56d4c50bbb8525328179e" },
  winter: { repository: "yanlingLabs/winter", head: "8b52ef83d1ba721a4dd80cdbb205c617f8656555", tree: "703ad5263ef0a249e9666faa1eaf18a0f19c8be1" },
};
/** Builder files changed AFTER run 39227365159 (the host-spawn binding fix: the hostClient core, its spec and the README; the run-3 trigger branch: the input pin file and its test). Like run 1's
 * list they are history for that run's pin; every other file run 2 pinned must still match the working tree. */
export const RUN2_SUPERSEDED_BUILDER_FILES = [`${BUILD}/README.md`, `${BUILD}/entries/host-client-core.ts`, `${BUILD}/guided-compile-inputs.pin.json`, `${BUILD}/guided-entries.test.ts`, `${BUILD}/test_guided_build.py`] as const;
/** Run 3's record of its origins: the same three heads as run 2 (the hostClient fix is in the builder origin, not in these). */
const RUN3_ORIGINS = RUN2_ORIGINS;
/** Builder files changed AFTER run 39327386044 (the provider worker names each refused arrival's site, C-P11; the run-4 trigger branch). History for run 3's
 * pin and, for the provider worker core, for run 2's too (the run-2 -> run-3 list above stays exactly the host-spawn fix). */
export const RUN3_SUPERSEDED_BUILDER_FILES = [`${BUILD}/README.md`, `${BUILD}/entries/provider-worker-core.ts`, `${BUILD}/guided-compile-inputs.pin.json`, `${BUILD}/guided-entries.test.ts`, `${BUILD}/test_guided_build.py`] as const;
export const RUN2_HISTORY_BUILDER_FILES = [...RUN2_SUPERSEDED_BUILDER_FILES, `${BUILD}/entries/provider-worker-core.ts`] as const;
/** Run 4's record of its origins: the runtime-sdk origin is the merge of PR 27 (the stub that names refusal sites); agent-sdk and Winter Core are run 3's. */
const RUN4_ORIGINS: Record<string, { repository: string; head: string; tree: string }> = {
  ...RUN3_ORIGINS,
  runtime: { repository: "yanlingLabs/winter-runtime-sdk", head: "a32330d64a920d1957876a36f7a4a210de6e30e7", tree: "175a8e58aad591efb77d4827003e61a78fde5f52" },
};
/** Builder files changed AFTER run 39391435225 (the run-5 trigger branch: the input pin file, its test and the README). History for run 4's pin only. */
export const RUN4_SUPERSEDED_BUILDER_FILES = [`${BUILD}/README.md`, `${BUILD}/guided-compile-inputs.pin.json`, `${BUILD}/test_guided_build.py`] as const;
/** Run 5's record of its origins: the runtime-sdk origin is the merge of PR 30 (the stub that accepts the engine's merged first message); agent-sdk and Winter Core are unchanged. */
const RUN5_ORIGINS: Record<string, { repository: string; head: string; tree: string }> = {
  ...RUN4_ORIGINS,
  runtime: { repository: "yanlingLabs/winter-runtime-sdk", head: "2b170ab0a0cd3d137b620b1a30dc0ea9502e1822", tree: "e507b5e54046c75a0deb77662c14f446fda81c1c" },
};
/** Builder files changed AFTER run 39399991186: its test reads the compile workflow from the retired-workflows directory now. History for run 5's pin only. */
export const RUN5_SUPERSEDED_BUILDER_FILES = [`${BUILD}/test_guided_build.py`] as const;
interface RunSpec { branch: string; artifactId: number; origins: Record<string, { repository: string; head: string; tree: string }>; placeholders: string[]; superseded: readonly string[] }
/** The runs this directory pins, by run id. A pin whose run id is not here is refused. */
const RUNS: Record<number, RunSpec> = {
  39165162201: { branch: "cowork/guided-packet-compile-fixture", artifactId: 12149668717, origins: RUN1_ORIGINS, placeholders: PLACEHOLDERS, superseded: SUPERSEDED_BUILDER_FILES },
  39227365159: { branch: "cowork/guided-packet-compile-fixture-2", artifactId: 12174387240, origins: RUN2_ORIGINS, placeholders: [], superseded: RUN2_HISTORY_BUILDER_FILES },
  39327386044: { branch: "cowork/guided-packet-compile-fixture-3", artifactId: 12223150881, origins: RUN3_ORIGINS, placeholders: [], superseded: RUN3_SUPERSEDED_BUILDER_FILES },
  39391435225: { branch: "cowork/guided-packet-compile-fixture-4", artifactId: 12249582986, origins: RUN4_ORIGINS, placeholders: [], superseded: RUN4_SUPERSEDED_BUILDER_FILES },
  39399991186: { branch: "cowork/guided-packet-compile-fixture-5", artifactId: 12254327073, origins: RUN5_ORIGINS, placeholders: [], superseded: RUN5_SUPERSEDED_BUILDER_FILES },
};

export function pinFiles(): string[] {
  return readdirSync(join(ROOT, INTAKE)).filter((name) => /^compile-\d+\.pin\.json$/.test(name));
}
export function loadContext(): Context {
  const inputs = JSON.parse(read(`${BUILD}/guided-compile-inputs.pin.json`)) as Inputs;
  return { inputs, dependencyListSha256: sha256(`${BUILD}/dependencies.lst`), pinsPy: read(`${BUILD}/pins.py`), workflow: read(".github/retired-workflows/cowork-guided-packet-compile-fixture.yml"), limits: inputs.limits,
    files: (path) => (existsSync(join(ROOT, path)) ? sha256(path) : null) };
}

/** Every disagreement between the pin and everything it must agree with. Empty means the cascade holds. */
export function pinViolations(pin: Pin, ctx: Context): string[] {
  const problems: string[] = [];
  const bad = (message: string) => problems.push(message);
  const { inputs } = ctx;
  const spec = RUNS[pin.run?.id];

  // 1. The run.
  if (pin.kind !== "winter-guided-compile-pin" || pin.formatVersion !== 1) bad("pin kind or format");
  if (!spec) { bad("pin run identity"); return problems; }
  if (pin.run.attempt !== 1 || pin.run.event !== "push" || pin.run.conclusion !== "success") bad("pin run identity");
  if (pin.run.branch !== spec.branch) bad("pin run branch");
  if (!hex(40).test(pin.run.armingCommit) || pin.run.armingCommit !== pin.workflowHead) bad("pin arming commit is the workflow head");
  if (pin.artifact.name !== `guided-packet-compile-${pin.run.id}` || pin.artifact.id !== spec.artifactId) bad("pin artifact identity");
  if (!hex(64).test(pin.artifact.zipSha256) || !(pin.artifact.zipBytes > 0)) bad("pin artifact zip digest or size");
  const days = (Date.parse(pin.artifact.expiresAt) - Date.parse(pin.run.createdAt)) / 86_400_000;
  if (!(days > 6.9 && days < 7.1) || inputs.retentionDays !== 7) bad("pin artifact expiry is seven days after the run");
  if (JSON.stringify(pin.artifact.members) !== JSON.stringify(["guided-packet.tar.gz", "packet-inventory.json"])) bad("pin artifact members");

  // 2. Hashes and sizes are well formed and inside the builder's own bounds.
  for (const [label, ent] of [["archive", pin.archive], ["inventory", pin.inventory], ["receipt", pin.receipt], ["inputs", pin.inputs], ["acquisition", pin.compilerAcquisition], ["Bun base", pin.bun.stageBase]] as Array<[string, Ent]>) {
    if (!hex(64).test(ent.sha256) || !(ent.bytes > 0)) bad(`pin ${label} hash or size`);
  }
  if (pin.inventory.fileBytes > ctx.limits.packetBytes || pin.inventory.fileCount > inputs.limits.packetEntries) bad("pin packet exceeds the builder's bound");
  if (pin.archive.bytes > ctx.limits.packetBytes) bad("pin archive exceeds the builder's bound");

  // 3. Origins: the pin is the builder's input pin file, origin by origin.
  const pairs: Array<[string, { head: string; tree: string; repository: string }]> = Object.entries(spec.origins);
  if (JSON.stringify(Object.keys(pin.origins).sort()) !== JSON.stringify(["runtime", "sdk", "winter"])) bad("pin origin set");
  for (const [role, want] of pairs) {
    const got = pin.origins[role];
    if (!got || got.head !== want.head || got.tree !== want.tree || got.repository !== want.repository) bad(`pin origin ${role} differs from the run's record`);
    if (got && (!hex(64).test(got.inventorySha256) || !(got.fileCount > 0))) bad(`pin origin ${role} inventory`);
  }
  if (!hex(40).test(pin.builder.head) || !hex(40).test(pin.builder.tree) || pin.builder.head === pin.workflowHead) bad("pin builder head and workflow head are distinct commits");

  // 4. Bun, dependencies, actions.
  for (const key of ["version", "target", "archiveSha256", "executableSha256"] as const) if (pin.bun[key] !== inputs.bun[key]) bad(`pin Bun ${key} differs from guided-compile-inputs.pin.json`);
  if (pin.bun.stageBase.sha256 !== pin.bun.executableSha256 || pin.bun.stageBase.path !== "stage/linux-bun-base") bad("pin Bun base is the pinned executable");
  if (pin.dependencies.listSha256 !== ctx.dependencyListSha256) bad("pin dependency list hash differs from dependencies.lst");
  if (!new RegExp(`DEPENDENCY_LIST_SHA256: ${pin.dependencies.listSha256}`).test(ctx.workflow)) bad("pin dependency list hash differs from the workflow env");
  if (pin.dependencies.packages !== inputs.dependencies.packages.length) bad("pin dependency package count");
  const edges = (inputs.dependencies.packages as Array<{ dependencies: Record<string, string> }>).reduce((n, item) => n + Object.keys(item.dependencies).length, 0);
  if (pin.dependencies.links !== edges || pin.symlinks.dependencyLinks !== edges) bad("pin dependency link count equals the dependency edges");
  if (!hex(64).test(pin.dependencies.storeSha256) || pin.dependencies.storeEntries < edges) bad("pin dependency store hash");
  if (JSON.stringify(pin.actions) !== JSON.stringify(inputs.actions)) bad("pin actions differ from guided-compile-inputs.pin.json");

  // 5. The inventory the builder promised: four roles, six natives, four metafiles, the six libraries.
  if (JSON.stringify(Object.keys(pin.artifacts.roles).sort()) !== JSON.stringify([...ROLES].sort())) bad("pin roles are exactly the four compiled roles");
  if (JSON.stringify(Object.keys(pin.artifacts.natives).sort()) !== JSON.stringify([...NATIVES].sort())) bad("pin natives are exactly the six native artifacts");
  if (JSON.stringify(Object.keys(pin.metafiles).sort()) !== JSON.stringify([...ROLES].sort())) bad("pin metafiles are exactly the four role metafiles");
  for (const name of [...ROLES, ...NATIVES]) if (!ctx.pinsPy.includes(`'${name}'`)) bad(`pins.py does not name ${name}`);
  for (const [name, ent] of [...Object.entries(pin.artifacts.roles), ...Object.entries(pin.artifacts.natives), ...Object.entries(pin.metafiles)]) if (!hex(64).test(ent.sha256) || !(ent.bytes > 0)) bad(`pin artifact ${name} hash or size`);
  if (Object.keys(pin.environment).length !== 6) bad("pin environment holds exactly six libraries");
  const placeholders = Object.entries(pin.artifacts.roles).filter(([, v]) => v.placeholder === true).map(([k]) => k).sort();
  if (JSON.stringify(placeholders) !== JSON.stringify([...spec.placeholders].sort())) bad("pin placeholders are exactly the run's declared set");
  if (Object.values(pin.artifacts.natives).some((v) => (v as { placeholder?: boolean }).placeholder !== undefined)) bad("pin natives are not placeholders");
  if (JSON.stringify([...pin.binding.notBindable].sort()) !== JSON.stringify([...spec.placeholders].sort()) || pin.binding.notBindable.some((n) => pin.binding.bindable.join("|").includes(n))) bad("pin binding excludes the placeholders");
  if (spec.placeholders.length === 0) for (const need of [String(pin.artifact.id), "verify_packet.py", "roles runtimeEntry, providerWorker, hostClient and instructionReader", "six native artifacts"]) if (!pin.binding.bindable.join("|").includes(need)) bad("pin binding names what it makes bindable");

  // 6. Links: the aliases are the builder's, the dependency links are the pin file's edges.
  const aliasCount = 6 * 4 + 1 + Object.values(inputs.dependencies.aliases).reduce((n, m) => n + Object.keys(m).length, 0);
  if (Object.keys(pin.resolverBindings).length !== aliasCount || pin.symlinks.resolverAliases !== aliasCount) bad("pin resolver aliases equal the builder's alias count");
  if (pin.symlinks.total !== pin.symlinks.resolverAliases + pin.symlinks.dependencyLinks) bad("pin symlink total");
  if (pin.archiveRules.regularFileMode !== "0400" || pin.archiveRules.symlinkMode !== "0777") bad("pin archive rules");

  // 7. Builder-origin bytes: what ran is what is committed. Editing a builder file after this pin must re-pin.
  if (Object.keys(pin.builder.files).length === 0) bad("pin builder files");
  for (const [path, digest] of Object.entries(pin.builder.files)) {
    const actual = ctx.files(path);
    if (actual === null) bad(`pinned builder file is gone: ${path}`);
    else if (actual !== digest && !spec.superseded.includes(path)) bad(`pinned builder file changed: ${path}`);
  }
  for (const path of spec.superseded) if (!(path in pin.builder.files)) bad(`pin builder files omit superseded ${path}`);
  for (const required of [`${BUILD}/build.py`, `${BUILD}/graph.py`, `${BUILD}/acquire.py`, `${BUILD}/pins.py`, `${BUILD}/guided-compile-inputs.pin.json`, `${BUILD}/dependencies.lst`, "scripts/guest-reader-build/build.py", "scripts/guest-reader-build/provenance.py"]) {
    if (!(required in pin.builder.files)) bad(`pin builder files omit ${required}`);
  }

  // 8. Nothing was executed or admitted.
  if (Object.values(pin.flags).some((v) => v !== false) || Object.keys(pin.flags).length < 5) bad("pin flags are all false");
  return problems;
}

const PINS = pinFiles().sort().map((file) => ({ file, pin: JSON.parse(read(`${INTAKE}/${file}`)) as Pin }));
const pinOf = (id: number) => PINS.find((entry) => entry.pin.run.id === id)!.pin;

describe("guided compile packet intake pins", () => {
  test("the compile pins are exactly the five known runs, each named by its run id", () => {
    expect(PINS.map((entry) => entry.file)).toEqual(["compile-39165162201.pin.json", "compile-39227365159.pin.json", "compile-39327386044.pin.json", "compile-39391435225.pin.json", "compile-39399991186.pin.json"]);
    for (const { file, pin } of PINS) expect(file).toBe(`compile-${pin.run.id}.pin.json`);
  });
  test("a pin for a run that is not in the table is refused", () => {
    const unknown = structuredClone(PINS[0]!.pin); unknown.run.id = 1;
    expect(pinViolations(unknown, loadContext())).toContain("pin run identity");
  });
  for (const { file, pin } of PINS) {
    test(`${file} agrees with every input it must agree with`, () => {
      expect(pinViolations(pin, loadContext())).toEqual([]);
    });
  }
  test("the README says run 1 is not bindable in full, run 2 is bound only through verify_packet.py --pin, and keeps the standing line and no C59 claim", () => {
    const readme = read(`${INTAKE}/README.md`);
    expect(readme).toContain("not bindable in full");
    expect(readme).toContain("providerWorker");
    expect(readme).toContain("hostClient");
    expect(readme).toContain("39227365159"); expect(readme).toContain("39327386044"); expect(readme).toContain("39391435225"); expect(readme).toContain("39399991186");
    expect(readme).toMatch(/--pin[^\n]*compile-39399991186\.pin\.json/);
    expect(readme).toMatch(/--pin[^\n]*compile-39391435225\.pin\.json/);
    expect(readme).toMatch(/--pin[^\n]*compile-39327386044\.pin\.json/);
    expect(readme).toMatch(/--pin[^\n]*compile-39227365159\.pin\.json/);
    expect(readme).toContain(STANDING_LINE);
    expect(readme).not.toMatch(/C59 (is|was) explained/i);
    expect(readme.toLowerCase()).toContain("frozen");
  });
  test("the workflow on this branch is still unarmed: neither pin can fire it", () => {
    expect(loadContext().workflow).toContain("BUILDER_HEAD: '0000000000000000000000000000000000000000'");
  });
  test("run 2 continuity with run 1 is exactly what the hashes say, and nothing in run 2 is a placeholder", () => {
    const one = pinOf(39165162201), two = pinOf(39227365159);
    const groups = ["roles", "natives"] as const;
    const hashes = (pin: Pin) => Object.fromEntries(groups.flatMap((g) => Object.entries(pin.artifacts[g]).map(([name, ent]) => [name, ent.sha256])));
    const a = hashes(one), b = hashes(two);
    const same = Object.keys(b).filter((name) => a[name] === b[name]).sort(), changed = Object.keys(b).filter((name) => a[name] !== b[name]).sort();
    expect(two.continuity?.previousRun).toBe(39165162201);
    expect([...two.continuity!.identicalToPreviousRun].sort()).toEqual(same);
    expect([...two.continuity!.changedFromPreviousRun].sort()).toEqual(changed);
    expect(changed).toEqual(["hostClient", "ownerLibrary", "providerWorker"]);
    expect(same).toEqual(["fileWorker", "instructionReader", "instructionReaderLauncher", "processWorker", "runtimeEntry", "runtimeLauncher", "toolLauncher"]);
    expect(Object.values(two.artifacts.roles).some((role) => role.placeholder !== undefined)).toBe(false);
    expect(two.binding.notBindable).toEqual([]);
    expect(Object.keys(two.environment).sort()).toEqual(Object.keys(one.environment).sort());
    expect(two.bun.stageBase.sha256).toBe(one.bun.stageBase.sha256);
  });
  test("run 3 differs from run 2 in exactly the hostClient, its builder files in exactly the five run-2 superseded ones, and nothing is a placeholder", () => {
    const two = pinOf(39227365159), three = pinOf(39327386044);
    const changed = [...ROLES, ...NATIVES].filter((name) => ((two.artifacts.roles[name] ?? two.artifacts.natives[name])!.sha256) !== ((three.artifacts.roles[name] ?? three.artifacts.natives[name])!.sha256)).sort();
    expect(changed).toEqual(["hostClient"]);
    expect(three.continuity?.previousRun).toBe(39227365159);
    expect([...three.continuity!.changedFromPreviousRun]).toEqual(["hostClient"]);
    expect([...three.continuity!.identicalToPreviousRun].sort()).toEqual([...ROLES, ...NATIVES].filter((name) => name !== "hostClient").sort());
    expect(Object.keys(three.builder.files).filter((path) => three.builder.files[path] !== two.builder.files[path]).sort()).toEqual([...RUN2_SUPERSEDED_BUILDER_FILES].sort());
    expect(Object.values(three.artifacts.roles).some((role) => role.placeholder !== undefined)).toBe(false);
    expect(three.binding.notBindable).toEqual([]);
    expect(JSON.stringify(three.origins)).toBe(JSON.stringify(two.origins));
  });
  test("run 4 differs from run 3 in exactly the providerWorker, its builder files in exactly the five run-3 superseded ones, and the runtime-sdk origin moved to the PR 27 merge", () => {
    const three = pinOf(39327386044), four = pinOf(39391435225);
    const changed = [...ROLES, ...NATIVES].filter((name) => ((three.artifacts.roles[name] ?? three.artifacts.natives[name])!.sha256) !== ((four.artifacts.roles[name] ?? four.artifacts.natives[name])!.sha256)).sort();
    expect(changed).toEqual(["providerWorker"]);
    expect(four.continuity?.previousRun).toBe(39327386044);
    expect([...four.continuity!.changedFromPreviousRun]).toEqual(["providerWorker"]);
    expect([...four.continuity!.identicalToPreviousRun].sort()).toEqual([...ROLES, ...NATIVES].filter((name) => name !== "providerWorker").sort());
    expect(Object.keys(four.builder.files).filter((path) => four.builder.files[path] !== three.builder.files[path]).sort()).toEqual([...RUN3_SUPERSEDED_BUILDER_FILES].sort());
    expect(Object.values(four.artifacts.roles).some((role) => role.placeholder !== undefined)).toBe(false);
    expect(four.binding.notBindable).toEqual([]);
    expect(four.origins.sdk).toEqual(three.origins.sdk); expect(four.origins.winter).toEqual(three.origins.winter);
    const runtimeFour = four.origins.runtime, runtimeThree = three.origins.runtime;
    expect(runtimeFour).toBeDefined(); expect(runtimeThree).toBeDefined();
    expect(runtimeFour!.head).toBe("a32330d64a920d1957876a36f7a4a210de6e30e7");
    expect(runtimeFour!.inventorySha256).not.toBe(runtimeThree!.inventorySha256);
    expect(JSON.stringify(four.environment)).toBe(JSON.stringify(three.environment));
    expect(four.bun).toEqual(three.bun); expect(four.dependencies).toEqual(three.dependencies);
  });
  test("run 5 differs from run 4 in exactly the providerWorker, its builder files in exactly the three run-4 superseded ones, and the runtime-sdk origin moved to the PR 30 merge", () => {
    const four = pinOf(39391435225), five = pinOf(39399991186);
    const changed = [...ROLES, ...NATIVES].filter((name) => ((four.artifacts.roles[name] ?? four.artifacts.natives[name])!.sha256) !== ((five.artifacts.roles[name] ?? five.artifacts.natives[name])!.sha256)).sort();
    expect(changed).toEqual(["providerWorker"]);
    expect(five.continuity?.previousRun).toBe(39391435225);
    expect([...five.continuity!.changedFromPreviousRun]).toEqual(["providerWorker"]);
    expect([...five.continuity!.identicalToPreviousRun].sort()).toEqual([...ROLES, ...NATIVES].filter((name) => name !== "providerWorker").sort());
    expect(Object.keys(five.builder.files).filter((path) => five.builder.files[path] !== four.builder.files[path]).sort()).toEqual([...RUN4_SUPERSEDED_BUILDER_FILES].sort());
    expect(Object.values(five.artifacts.roles).some((role) => role.placeholder !== undefined)).toBe(false);
    expect(five.binding.notBindable).toEqual([]);
    expect(five.origins.sdk).toEqual(four.origins.sdk); expect(five.origins.winter).toEqual(four.origins.winter);
    const runtimeFive = five.origins.runtime, runtimeFour = four.origins.runtime;
    expect(runtimeFive).toBeDefined(); expect(runtimeFour).toBeDefined();
    expect(runtimeFive!.head).toBe("2b170ab0a0cd3d137b620b1a30dc0ea9502e1822");
    expect(runtimeFive!.tree).toBe("e507b5e54046c75a0deb77662c14f446fda81c1c");
    expect(runtimeFive!.inventorySha256).not.toBe(runtimeFour!.inventorySha256);
    expect(JSON.stringify(five.environment)).toBe(JSON.stringify(four.environment));
    expect(five.bun).toEqual(four.bun); expect(five.dependencies).toEqual(four.dependencies);
  });
  test("verify_packet.py and its synthetic-packet tests pass (pure data, nothing executed)", () => {
    const run = spawnSync("python3", ["-I", "-B", join(ROOT, INTAKE, "test_verify_packet.py")], { encoding: "utf8" });
    expect(run.stderr + run.stdout).toContain("OK");
    expect(run.status).toBe(0);
  });
  const evidence = process.env.WINTER_GUIDED_EVIDENCE_DIR, evidenceRun = process.env.WINTER_GUIDED_EVIDENCE_RUN;
  test.skipIf(!evidence || !evidenceRun)("optional: the downloaded packet verifies against its pin (set WINTER_GUIDED_EVIDENCE_DIR to the artifact folder and WINTER_GUIDED_EVIDENCE_RUN to the run id)", () => {
    const run = spawnSync("python3", ["-I", "-B", join(ROOT, INTAKE, "verify_packet.py"), join(evidence!, "guided-packet.tar.gz"), join(evidence!, "packet-inventory.json"), "--pin", join(ROOT, INTAKE, `compile-${evidenceRun}.pin.json`)], { encoding: "utf8" });
    expect(run.status).toBe(0);
  });
});

// One broken pin per check; each must be caught by its own named violation.
type Mutate = (pin: Pin, ctx: Context) => void;
const FLIP = (hexValue: string) => (hexValue[0] === "0" ? "1" : "0") + hexValue.slice(1);
const RUN1 = 39165162201, RUN2 = 39227365159;
const MUTATIONS: Array<[string, Mutate, string, number[]?]> = [
  ["wrong run id", (p) => { p.run.id = 1; }, "pin run identity"],
  ["second attempt", (p) => { p.run.attempt = 2; }, "pin run identity"],
  ["failed conclusion", (p) => { p.run.conclusion = "failure"; }, "pin run identity"],
  ["wrong branch", (p) => { p.run.branch = "cowork/other"; }, "pin run branch"],
  ["arming commit differs from workflow head", (p) => { p.run.armingCommit = "1".repeat(40); }, "pin arming commit is the workflow head"],
  ["artifact name differs", (p) => { p.artifact.name = "other"; }, "pin artifact identity"],
  ["artifact zip digest malformed", (p) => { p.artifact.zipSha256 = "xyz"; }, "pin artifact zip digest or size"],
  ["expiry is not seven days", (p) => { p.artifact.expiresAt = "2027-01-01T00:00:00Z"; }, "pin artifact expiry is seven days after the run"],
  ["artifact members differ", (p) => { p.artifact.members.push("extra"); }, "pin artifact members"],
  ["archive hash malformed", (p) => { p.archive.sha256 = "abc"; }, "pin archive hash or size"],
  ["inventory size zero", (p) => { p.inventory.bytes = 0; }, "pin inventory hash or size"],
  ["packet over the builder bound", (p) => { p.inventory.fileBytes = 2 ** 31; }, "pin packet exceeds the builder's bound"],
  ["sdk origin head drifts", (p) => { p.origins.sdk!.head = "1".repeat(40); }, "pin origin sdk differs from the run's record"],
  ["runtime origin tree drifts", (p) => { p.origins.runtime!.tree = "1".repeat(40); }, "pin origin runtime differs from the run's record"],
  ["winter origin repository drifts", (p) => { p.origins.winter!.repository = "someone/else"; }, "pin origin winter differs from the run's record"],
  ["extra origin", (p) => { p.origins.extra = { ...p.origins.sdk! }; }, "pin origin set"],
  ["origin inventory hash malformed", (p) => { p.origins.sdk!.inventorySha256 = "x"; }, "pin origin sdk inventory"],
  ["builder head equals workflow head", (p) => { p.builder.head = p.workflowHead; }, "pin builder head and workflow head are distinct commits"],
  ["Bun archive hash drifts", (p) => { p.bun.archiveSha256 = FLIP(p.bun.archiveSha256); }, "pin Bun archiveSha256 differs"],
  ["Bun version drifts", (p) => { p.bun.version = "1.4.2"; }, "pin Bun version differs"],
  ["Bun base is not the executable", (p) => { p.bun.stageBase.sha256 = FLIP(p.bun.stageBase.sha256); }, "pin Bun base is the pinned executable"],
  ["dependency list hash drifts", (p) => { p.dependencies.listSha256 = FLIP(p.dependencies.listSha256); }, "pin dependency list hash differs from dependencies.lst"],
  ["dependency package count drifts", (p) => { p.dependencies.packages = 19; }, "pin dependency package count"],
  ["dependency link count drifts", (p) => { p.dependencies.links = 17; }, "pin dependency link count equals the dependency edges"],
  ["dependency store hash malformed", (p) => { p.dependencies.storeSha256 = "1"; }, "pin dependency store hash"],
  ["action SHA drifts", (p) => { p.actions["actions/checkout"] = "1".repeat(40); }, "pin actions differ from guided-compile-inputs.pin.json"],
  ["a fifth role", (p) => { p.artifacts.roles.extra = { ...p.artifacts.roles.hostClient! }; }, "pin roles are exactly the four compiled roles"],
  ["a native missing", (p) => { delete p.artifacts.natives.fileWorker; }, "pin natives are exactly the six native artifacts"],
  ["a metafile missing", (p) => { delete p.metafiles.hostClient; }, "pin metafiles are exactly the four role metafiles"],
  ["an artifact hash malformed", (p) => { p.artifacts.natives.toolLauncher!.sha256 = "x"; }, "pin artifact toolLauncher hash or size"],
  ["a library dropped", (p) => { delete p.environment[Object.keys(p.environment)[0]!]; }, "pin environment holds exactly six libraries"],
  ["hostClient placeholder flag removed", (p) => { delete p.artifacts.roles.hostClient!.placeholder; }, "pin placeholders are exactly the run's declared set", [RUN1]],
  ["providerWorker placeholder flag removed", (p) => { delete p.artifacts.roles.providerWorker!.placeholder; }, "pin placeholders are exactly the run's declared set", [RUN1]],
  ["a real role marked placeholder", (p) => { p.artifacts.roles.runtimeEntry!.placeholder = true; }, "pin placeholders are exactly the run's declared set"],
  ["a role marked placeholder in the run that has none", (p) => { p.artifacts.roles.hostClient!.placeholder = true; }, "pin placeholders are exactly the run's declared set", [RUN2]],
  ["a role marked not bindable in the run that binds all", (p) => { p.binding.notBindable = ["hostClient"]; }, "pin binding excludes the placeholders", [RUN2]],
  ["the binding forgets the verifier", (p) => { p.binding.bindable = p.binding.bindable.map((line) => line.replace("verify_packet.py", "a check")); }, "pin binding names what it makes bindable", [RUN2]],
  ["the binding forgets the artifact id", (p) => { p.binding.bindable = p.binding.bindable.map((line) => line.replace(String(p.artifact.id), "0")); }, "pin binding names what it makes bindable", [RUN2]],
  ["a native marked placeholder", (p) => { (p.artifacts.natives.toolLauncher as { placeholder?: boolean }).placeholder = true; }, "pin natives are not placeholders"],
  ["binding lists a placeholder as bindable", (p) => { p.binding.bindable.push("hostClient"); }, "pin binding excludes the placeholders", [RUN1]],
  ["binding drops a placeholder from the refusals", (p) => { p.binding.notBindable = ["hostClient"]; }, "pin binding excludes the placeholders", [RUN1]],
  ["an alias dropped", (p) => { delete p.resolverBindings[Object.keys(p.resolverBindings)[0]!]; }, "pin resolver aliases equal the builder's alias count"],
  ["symlink total drifts", (p) => { p.symlinks.total = 46; }, "pin symlink total"],
  ["archive rules claim executable modes", (p) => { p.archiveRules.regularFileMode = "0755"; }, "pin archive rules"],
  ["a builder file changes", (p) => { const k = `${BUILD}/build.py`; p.builder.files[k] = FLIP(p.builder.files[k]!); }, "pinned builder file changed"],
  ["a frozen-core builder file changes (graph)", (p) => { const k = `${BUILD}/graph.py`; p.builder.files[k] = FLIP(p.builder.files[k]!); }, "pinned builder file changed"],
  ["a superseded file is no longer in the pin", (p) => { delete p.builder.files[`${BUILD}/entries/host-client.ts`]; }, "pin builder files omit superseded", [RUN1]],
  ["a real-entries file that run 2 froze changes", (p) => { const k = `${BUILD}/entries/provider-worker.ts`; p.builder.files[k] = FLIP(p.builder.files[k]!); }, "pinned builder file changed", [RUN2]],
  ["the builder pins.py changes after run 2", (p) => { const k = `${BUILD}/pins.py`; p.builder.files[k] = FLIP(p.builder.files[k]!); }, "pinned builder file changed", [RUN2]],
  ["a run-2 superseded file is no longer in the pin", (p) => { delete p.builder.files[`${BUILD}/entries/host-client-core.ts`]; }, "pin builder files omit superseded", [RUN2]],
  ["a builder file is gone", (p) => { p.builder.files["scripts/guest-guided-build/nope.py"] = "0".repeat(64); }, "pinned builder file is gone"],
  ["the reader helper is no longer pinned", (p) => { delete p.builder.files["scripts/guest-reader-build/provenance.py"]; }, "pin builder files omit scripts/guest-reader-build/provenance.py"],
  ["no builder files", (p) => { p.builder.files = {}; }, "pin builder files"],
  ["a flag claims execution", (p) => { p.flags.outputsExecuted = true; }, "pin flags are all false"],
  ["flags dropped", (p) => { p.flags = {}; }, "pin flags are all false"],
  ["wrong kind", (p) => { p.kind = "other"; }, "pin kind or format"],
];

describe("guided compile packet intake pin mutations", () => {
  const ctx = loadContext();
  test("no duplicate names and a table large enough to mean something", () => {
    expect(new Set(MUTATIONS.map(([name]) => name)).size).toBe(MUTATIONS.length);
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(50);
  });
  for (const { file, pin } of PINS) {
    for (const [name, mutate, expected, runs] of MUTATIONS) {
      if (runs && !runs.includes(pin.run.id)) continue;
      test(`${file}: caught by its own check: ${name}`, () => {
        const broken = structuredClone(pin);
        mutate(broken, ctx);
        expect(JSON.stringify(broken)).not.toBe(JSON.stringify(pin));
        expect(pinViolations(broken, ctx).some((message) => message.includes(expected))).toBe(true);
      });
    }
    test(`${file}: context drift is caught too: the workflow env hash and the pins.py names`, () => {
      expect(pinViolations(pin, { ...ctx, workflow: ctx.workflow.replace(/DEPENDENCY_LIST_SHA256: \w+/, "DEPENDENCY_LIST_SHA256: 0") }).join("\n")).toContain("pin dependency list hash differs from the workflow env");
      expect(pinViolations(pin, { ...ctx, pinsPy: ctx.pinsPy.replace("'hostClient'", "'x'") }).join("\n")).toContain("pins.py does not name hostClient");
      expect(pinViolations(pin, { ...ctx, files: () => "0".repeat(64) }).join("\n")).toContain("pinned builder file changed");
      expect(pinViolations(pin, { ...ctx, limits: { packetBytes: 1 } }).join("\n")).toContain("pin archive exceeds the builder's bound");
    });
  }
  test("every violation message is exercised by a mutation or by the context-drift test", () => {
    const source = readFileSync(import.meta.path, "utf8");
    const body = source.slice(source.indexOf("export function pinViolations"), source.indexOf('describe("guided compile packet intake pins"'));
    const messages = [...body.matchAll(/bad\((["`])((?:\\.|(?!\1).)*)\1\)/g)].map((m) => (m[2] as string).split("${")[0] as string);
    const drift = ["pin dependency list hash differs from the workflow env", "pins.py does not name ", "pinned builder file changed", "pinned builder file is gone", "pin archive exceeds the builder's bound"];
    const uncovered = messages.filter((message) => message.length > 0 && !MUTATIONS.some(([, , e]) => e.includes(message) || message.includes(e)) && !drift.some((d) => d.includes(message) || message.includes(d)));
    expect(uncovered).toEqual([]);
  });
});

describe("run 2's superseded builder files are a short, explicit list", () => {
  test("only the host-spawn fix is superseded; the provider side and the build logic are not", () => {
    expect([...RUN2_SUPERSEDED_BUILDER_FILES].sort()).toEqual([`${BUILD}/README.md`, `${BUILD}/entries/host-client-core.ts`, `${BUILD}/guided-compile-inputs.pin.json`, `${BUILD}/guided-entries.test.ts`, `${BUILD}/test_guided_build.py`]);
    for (const frozen of ["build.py", "graph.py", "acquire.py", "pins.py", "entries/provider-worker.ts", "entries/provider-worker-core.ts", "entries/host-client.ts"]) expect(RUN2_SUPERSEDED_BUILDER_FILES as readonly string[]).not.toContain(`${BUILD}/${frozen}`);
  });
});

describe("the superseded builder files are a short, explicit list", () => {
  test("only the real-entries change is superseded; the build logic that produced the artifact never is", () => {
    expect([...SUPERSEDED_BUILDER_FILES].sort()).toEqual([
      `${BUILD}/README.md`, `${BUILD}/entries/host-client.ts`, `${BUILD}/entries/provider-worker.ts`, `${BUILD}/guided-compile-inputs.pin.json`, `${BUILD}/pins.py`, `${BUILD}/test_guided_build.py`]);
    for (const frozen of ["build.py", "graph.py", "acquire.py", "pin-deps.ts", "dependencies.lst"]) expect(SUPERSEDED_BUILDER_FILES as readonly string[]).not.toContain(`${BUILD}/${frozen}`);
  });
});

describe("run 3's superseded builder files are a short, explicit list", () => {
  test("only the provider-site change and the run-4 trigger are superseded; the build logic, the hostClient and the other entries are not", () => {
    expect([...RUN3_SUPERSEDED_BUILDER_FILES].sort()).toEqual([`${BUILD}/README.md`, `${BUILD}/entries/provider-worker-core.ts`, `${BUILD}/guided-compile-inputs.pin.json`, `${BUILD}/guided-entries.test.ts`, `${BUILD}/test_guided_build.py`]);
    for (const frozen of ["build.py", "graph.py", "acquire.py", "pins.py", "entries/provider-worker.ts", "entries/host-client.ts", "entries/host-client-core.ts"]) expect(RUN3_SUPERSEDED_BUILDER_FILES as readonly string[]).not.toContain(`${BUILD}/${frozen}`);
  });
  test("a pin that omits a run-3 superseded file is refused", () => {
    const three = PINS.find((item) => item.pin.run.id === 39327386044)!.pin, broken = structuredClone(three);
    delete broken.builder.files[`${BUILD}/entries/provider-worker-core.ts`];
    expect(pinViolations(broken, loadContext()).join("\n")).toContain("pin builder files omit superseded");
  });
});
