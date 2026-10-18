// Cascade tests for the guided compile packet's intake pin (scripts/guest-guided-intake/compile-<run>.pin.json).
// The pin records what compile run 39165162201 produced and what the audit found. These tests cannot download the
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
};
type Inputs = {
  bun: { version: string; target: string; archiveSha256: string; executableSha256: string };
  origins: { agentSdk: { head: string; tree: string; repository: string }; runtimeSdk: { head: string; tree: string; repository: string }; winterCore: { head: string; tree: string; repository: string } };
  dependencies: { packages: unknown[]; aliases: Record<string, Record<string, string>> };
  actions: Record<string, string>; retentionDays: number; limits: { packetBytes: number; packetEntries: number };
};
export interface Context { inputs: Inputs; dependencyListSha256: string; pinsPy: string; files: (path: string) => string | null; workflow: string; limits: { packetBytes: number } }

export function pinFiles(): string[] {
  return readdirSync(join(ROOT, INTAKE)).filter((name) => /^compile-\d+\.pin\.json$/.test(name));
}
export function loadContext(): Context {
  const inputs = JSON.parse(read(`${BUILD}/guided-compile-inputs.pin.json`)) as Inputs;
  return { inputs, dependencyListSha256: sha256(`${BUILD}/dependencies.lst`), pinsPy: read(`${BUILD}/pins.py`), workflow: read(".github/workflows/cowork-guided-packet-compile-fixture.yml"), limits: inputs.limits,
    files: (path) => (existsSync(join(ROOT, path)) ? sha256(path) : null) };
}

/** Every disagreement between the pin and everything it must agree with. Empty means the cascade holds. */
export function pinViolations(pin: Pin, ctx: Context): string[] {
  const problems: string[] = [];
  const bad = (message: string) => problems.push(message);
  const { inputs } = ctx;

  // 1. The run.
  if (pin.kind !== "winter-guided-compile-pin" || pin.formatVersion !== 1) bad("pin kind or format");
  if (pin.run.id !== 39165162201 || pin.run.attempt !== 1 || pin.run.event !== "push" || pin.run.conclusion !== "success") bad("pin run identity");
  if (pin.run.branch !== "cowork/guided-packet-compile-fixture") bad("pin run branch");
  if (!hex(40).test(pin.run.armingCommit) || pin.run.armingCommit !== pin.workflowHead) bad("pin arming commit is the workflow head");
  if (pin.artifact.name !== `guided-packet-compile-${pin.run.id}` || pin.artifact.id !== 12149668717) bad("pin artifact identity");
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
  const pairs: Array<[string, { head: string; tree: string; repository: string }]> = [["sdk", inputs.origins.agentSdk], ["runtime", inputs.origins.runtimeSdk], ["winter", inputs.origins.winterCore]];
  if (JSON.stringify(Object.keys(pin.origins).sort()) !== JSON.stringify(["runtime", "sdk", "winter"])) bad("pin origin set");
  for (const [role, want] of pairs) {
    const got = pin.origins[role];
    if (!got || got.head !== want.head || got.tree !== want.tree || got.repository !== want.repository) bad(`pin origin ${role} differs from guided-compile-inputs.pin.json`);
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
  if (JSON.stringify(placeholders) !== JSON.stringify(PLACEHOLDERS)) bad("pin placeholders are exactly providerWorker and hostClient");
  if (Object.values(pin.artifacts.natives).some((v) => (v as { placeholder?: boolean }).placeholder !== undefined)) bad("pin natives are not placeholders");
  if (JSON.stringify(pin.binding.notBindable.sort()) !== JSON.stringify(PLACEHOLDERS) || pin.binding.notBindable.some((n) => pin.binding.bindable.join("|").includes(n))) bad("pin binding excludes the placeholders");

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
    else if (actual !== digest) bad(`pinned builder file changed: ${path}`);
  }
  for (const required of [`${BUILD}/build.py`, `${BUILD}/graph.py`, `${BUILD}/acquire.py`, `${BUILD}/pins.py`, `${BUILD}/guided-compile-inputs.pin.json`, `${BUILD}/dependencies.lst`, "scripts/guest-reader-build/build.py", "scripts/guest-reader-build/provenance.py"]) {
    if (!(required in pin.builder.files)) bad(`pin builder files omit ${required}`);
  }

  // 8. Nothing was executed or admitted.
  if (Object.values(pin.flags).some((v) => v !== false) || Object.keys(pin.flags).length < 5) bad("pin flags are all false");
  return problems;
}

describe("guided compile packet intake pin", () => {
  const files = pinFiles();
  test("exactly one compile pin exists and its name carries the run id", () => {
    expect(files).toEqual(["compile-39165162201.pin.json"]);
  });
  const pin = JSON.parse(read(`${INTAKE}/compile-39165162201.pin.json`)) as Pin;
  test("the pin agrees with every input it must agree with", () => {
    expect(pinViolations(pin, loadContext())).toEqual([]);
  });
  test("the README says the packet is not bindable in full, and keeps the standing line and no C59 claim", () => {
    const readme = read(`${INTAKE}/README.md`);
    expect(readme).toContain("not bindable in full");
    expect(readme).toContain("providerWorker");
    expect(readme).toContain("hostClient");
    expect(readme).toContain(STANDING_LINE);
    expect(readme).not.toMatch(/C59 (is|was) explained/i);
    expect(readme.toLowerCase()).toContain("frozen");
  });
  test("the workflow on this branch is still unarmed: the pin cannot fire it", () => {
    expect(loadContext().workflow).toContain("BUILDER_HEAD: '0000000000000000000000000000000000000000'");
  });
  test("verify_packet.py and its synthetic-packet tests pass (pure data, nothing executed)", () => {
    const run = spawnSync("python3", ["-I", "-B", join(ROOT, INTAKE, "test_verify_packet.py")], { encoding: "utf8" });
    expect(run.stderr + run.stdout).toContain("OK");
    expect(run.status).toBe(0);
  });
  const evidence = process.env.WINTER_GUIDED_EVIDENCE_DIR;
  test.skipIf(!evidence)("optional: the downloaded packet verifies against the pin (set WINTER_GUIDED_EVIDENCE_DIR to the artifact folder)", () => {
    const run = spawnSync("python3", ["-I", "-B", join(ROOT, INTAKE, "verify_packet.py"), join(evidence!, "guided-packet.tar.gz"), join(evidence!, "packet-inventory.json")], { encoding: "utf8" });
    expect(run.status).toBe(0);
  });
});

// One broken pin per check; each must be caught by its own named violation.
type Mutate = (pin: Pin, ctx: Context) => void;
const FLIP = (hexValue: string) => (hexValue[0] === "0" ? "1" : "0") + hexValue.slice(1);
const MUTATIONS: Array<[string, Mutate, string]> = [
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
  ["sdk origin head drifts", (p) => { p.origins.sdk!.head = "1".repeat(40); }, "pin origin sdk differs from guided-compile-inputs.pin.json"],
  ["runtime origin tree drifts", (p) => { p.origins.runtime!.tree = "1".repeat(40); }, "pin origin runtime differs from guided-compile-inputs.pin.json"],
  ["winter origin repository drifts", (p) => { p.origins.winter!.repository = "someone/else"; }, "pin origin winter differs from guided-compile-inputs.pin.json"],
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
  ["hostClient placeholder flag removed", (p) => { delete p.artifacts.roles.hostClient!.placeholder; }, "pin placeholders are exactly providerWorker and hostClient"],
  ["providerWorker placeholder flag removed", (p) => { delete p.artifacts.roles.providerWorker!.placeholder; }, "pin placeholders are exactly providerWorker and hostClient"],
  ["a real role marked placeholder", (p) => { p.artifacts.roles.runtimeEntry!.placeholder = true; }, "pin placeholders are exactly providerWorker and hostClient"],
  ["a native marked placeholder", (p) => { (p.artifacts.natives.toolLauncher as { placeholder?: boolean }).placeholder = true; }, "pin natives are not placeholders"],
  ["binding lists a placeholder as bindable", (p) => { p.binding.bindable.push("hostClient"); }, "pin binding excludes the placeholders"],
  ["binding drops a placeholder from the refusals", (p) => { p.binding.notBindable = ["hostClient"]; }, "pin binding excludes the placeholders"],
  ["an alias dropped", (p) => { delete p.resolverBindings[Object.keys(p.resolverBindings)[0]!]; }, "pin resolver aliases equal the builder's alias count"],
  ["symlink total drifts", (p) => { p.symlinks.total = 46; }, "pin symlink total"],
  ["archive rules claim executable modes", (p) => { p.archiveRules.regularFileMode = "0755"; }, "pin archive rules"],
  ["a builder file changes", (p) => { const k = Object.keys(p.builder.files)[0]!; p.builder.files[k] = FLIP(p.builder.files[k]!); }, "pinned builder file changed"],
  ["a builder file is gone", (p) => { p.builder.files["scripts/guest-guided-build/nope.py"] = "0".repeat(64); }, "pinned builder file is gone"],
  ["the reader helper is no longer pinned", (p) => { delete p.builder.files["scripts/guest-reader-build/provenance.py"]; }, "pin builder files omit scripts/guest-reader-build/provenance.py"],
  ["no builder files", (p) => { p.builder.files = {}; }, "pin builder files"],
  ["a flag claims execution", (p) => { p.flags.outputsExecuted = true; }, "pin flags are all false"],
  ["flags dropped", (p) => { p.flags = {}; }, "pin flags are all false"],
  ["wrong kind", (p) => { p.kind = "other"; }, "pin kind or format"],
];

describe("guided compile packet intake pin mutations", () => {
  const pin = JSON.parse(read(`${INTAKE}/compile-39165162201.pin.json`)) as Pin;
  const ctx = loadContext();
  test("no duplicate names and a table large enough to mean something", () => {
    expect(new Set(MUTATIONS.map(([name]) => name)).size).toBe(MUTATIONS.length);
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(45);
  });
  for (const [name, mutate, expected] of MUTATIONS) {
    test(`caught by its own check: ${name}`, () => {
      const broken = structuredClone(pin);
      mutate(broken, ctx);
      expect(JSON.stringify(broken)).not.toBe(JSON.stringify(pin));
      expect(pinViolations(broken, ctx).some((message) => message.includes(expected))).toBe(true);
    });
  }
  test("context drift is caught too: the workflow env hash and the pins.py names", () => {
    expect(pinViolations(pin, { ...ctx, workflow: ctx.workflow.replace(/DEPENDENCY_LIST_SHA256: \w+/, "DEPENDENCY_LIST_SHA256: 0") }).join("\n")).toContain("pin dependency list hash differs from the workflow env");
    expect(pinViolations(pin, { ...ctx, pinsPy: ctx.pinsPy.replace("'hostClient'", "'x'") }).join("\n")).toContain("pins.py does not name hostClient");
    expect(pinViolations(pin, { ...ctx, files: () => "0".repeat(64) }).join("\n")).toContain("pinned builder file changed");
    expect(pinViolations(pin, { ...ctx, limits: { packetBytes: 1 } }).join("\n")).toContain("pin archive exceeds the builder's bound");
  });
  test("every violation message is exercised by a mutation or by the context-drift test", () => {
    const source = readFileSync(import.meta.path, "utf8");
    const body = source.slice(source.indexOf("export function pinViolations"), source.indexOf('describe("guided compile packet intake pin"'));
    const messages = [...body.matchAll(/bad\((["`])((?:\\.|(?!\1).)*)\1\)/g)].map((m) => (m[2] as string).split("${")[0] as string);
    const drift = ["pin dependency list hash differs from the workflow env", "pins.py does not name ", "pinned builder file changed", "pinned builder file is gone", "pin archive exceeds the builder's bound"];
    const uncovered = messages.filter((message) => message.length > 0 && !MUTATIONS.some(([, , e]) => e.includes(message) || message.includes(e)) && !drift.some((d) => d.includes(message) || message.includes(d)));
    expect(uncovered).toEqual([]);
  });
});
