// Tripwires for `.github/workflows/cowork-guided-packet-compile-fixture.yml`, the ONE-RUN, COMPILE-ONLY workflow
// for the guided packet (scripts/guest-guided-build/README.md). The author never triggers it; the owner approves the
// single run. A workflow that can never fire by accident and one that can look identical in a diff, so each property
// is asserted on the PARSED workflow. `violations()` is a pure function of the workflow text; the mutation table at
// the bottom feeds it a deliberately broken copy per gate and requires that every single removal is caught by its OWN
// named violation, so a gate that silently stopped checking fails here.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const WORKFLOWS_DIR = join(ROOT, ".github", "workflows");
const BUILD_DIR = "scripts/guest-guided-build";
const WORKFLOW_NAME = "cowork-guided-packet-compile-fixture.yml";
const SOURCE_NAME = "cowork-guided-build-source.yml";
const TRIGGER_BRANCH = "cowork/guided-packet-compile-fixture-2";
const REPOSITORY = "yanlingLabs/winter-runtime-sdk";
const ALLOWED_ACTIONS = new Set(["actions/checkout", "actions/upload-artifact"]);
// Branches that already fired, or are armed for, another workflow, or that carry this builder's own source: never reusable here.
const USED_BRANCHES = ["cowork/instruction-reader-compile-fixture", "cowork/reader-hosted-dependency-probe", "cowork/reader-hosted-fixture-stderr", "cowork/guided-packet-build", "cowork/guided-packet-compile-fixture"];
const ZERO_HEAD = "0".repeat(40);
const BUN_URL = "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-aarch64.zip";
const WORKFLOW_PATH = ".github/workflows/cowork-guided-packet-compile-fixture.yml";
/** The arming guard, line for line. It runs before any builder code is checked out and refuses unless BUILDER_HEAD is an
 * ancestor of the pushed commit AND the whole difference is the one BUILDER_HEAD line of this workflow. */
const GUARD: Array<[string, string]> = [
  ["the strict shell", "set -euo pipefail"],
  ["the unarmed refusal", `test "$BUILDER_HEAD" != "${ZERO_HEAD}"`],
  ["the ancestor check", 'git merge-base --is-ancestor "$BUILDER_HEAD" "$GITHUB_SHA"'],
  ["the single-file check", `test "$(git diff --name-only "$BUILDER_HEAD" "$GITHUB_SHA")" = "${WORKFLOW_PATH}"`],
  ["the numstat check", `test "$(git diff --numstat "$BUILDER_HEAD" "$GITHUB_SHA")" = "$(printf '1\\t1\\t%s' ${WORKFLOW_PATH})"`],
  ["the diff capture", `armed_diff=$(git diff -U0 --no-color "$BUILDER_HEAD" "$GITHUB_SHA" | grep -E '^[-+][^-+]' || true)`],
  ["the exact one-line diff check", `test "$armed_diff" = "$(printf '%s\\n%s' "-  BUILDER_HEAD: '${ZERO_HEAD}'" "+  BUILDER_HEAD: '$BUILDER_HEAD'")"`],
  ["the builder-head checkout", 'git checkout --detach --quiet "$BUILDER_HEAD"'],
];
const CC_LINE = `guided_cc=$(python3 -I -S -B -c 'import pathlib,shutil; print(pathlib.Path(shutil.which("cc")).resolve())')`;

type Step = { name?: string; id?: string; "continue-on-error"?: boolean; uses?: string; run?: string; if?: string; shell?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Doc = {
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  env?: Record<string, unknown>;
  jobs?: Record<string, { if?: string; "runs-on"?: string; permissions?: unknown; env?: Record<string, unknown>; steps?: Step[]; "timeout-minutes"?: number }>;
};
type Pin = {
  bun: { version: string; archiveSha256: string; executableSha256: string };
  origins: { agentSdk: { head: string }; runtimeSdk: { head: string }; winterCore: { head: string } };
  dependencies: { packages: Array<{ id: string; sha512: string; url: string }> };
  trigger: { branch: string; workflow: string; sourceWorkflow: string };
  actions: Record<string, string>;
  retentionDays: number;
};
const yaml = (Bun as unknown as { YAML: { parse(source: string): unknown } }).YAML;
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The build CLI's own flag names, read from build.py's argparse lines. */
function buildFlags(buildPy: string): { all: string[]; required: string[] } {
  const names = new Set<string>();
  for (const m of buildPy.matchAll(/for name in \(([^)]*)\):parser\.add_argument/g)) for (const n of (m[1] as string).matchAll(/'([\w-]+)'/g)) names.add(`--${n[1]}`);
  const required = [...names];
  for (const m of buildPy.matchAll(/parser\.add_argument\('(--[\w-]+)'/g)) { names.add(m[1] as string); required.push(m[1] as string); }
  return { all: [...names].sort(), required: required.sort() };
}

/** The shell lines a step runs: continuations joined, comments and blanks dropped. */
function logicalLines(run: string): string[] {
  const out: string[] = [];
  let carry = "";
  for (const raw of run.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.endsWith("\\")) { carry += `${line.slice(0, -1).trim()} `; continue; }
    out.push(`${carry}${line}`);
    carry = "";
  }
  return out;
}

/** Every reviewed command shape. Anything else in a run block is a violation: the list is closed on purpose. */
const SHAPES: RegExp[] = [
  /^guided_fixture=\$\(mktemp -d \/var\/tmp\/winter-guided-compile\.XXXXXXXX\)$/,
  /^printf 'GUIDED_FIXTURE=%s\\n' "\$guided_fixture" >> "\$GITHUB_ENV"$/,
  /^mkdir -m 700 "\$guided_fixture\/dependencies" "\$guided_fixture\/archive" "\$guided_fixture\/tarballs"$/,
  /^curl --fail --location --proto '=https' --tlsv1\.2 --max-time 120 --max-filesize \d+ "[^"]+" --output "\$guided_fixture\/[\w$/.]+"$/,
  /^printf '%s  %s\\n' "\$[A-Z_a-z0-9]+" ("\$guided_fixture\/[\w$/.]+"|scripts\/guest-guided-build\/dependencies\.lst) \| sha(256|512)sum --check --strict -$/,
  /^while read -r dependency_sha512 dependency_file dependency_url; do$/,
  /^done < scripts\/guest-guided-build\/dependencies\.lst$/,
  /^python3 -I -S -B scripts\/guest-guided-build\/acquire\.py (bun "\$guided_fixture\/bun\.zip"|deps "\$guided_fixture\/tarballs") "\$guided_fixture"$/,
  /^python3 -I -S -B scripts\/guest-guided-build\/build\.py( --[a-z-]+ "[^"]*"| --sysroot \/)+$/,
];

export interface Context { pin: Pin; buildPy: string; dependencyList: string; others: Record<string, string>; sourceWorkflow: string; exists: (path: string) => boolean }
export function loadContext(): Context {
  const others: Record<string, string> = {};
  for (const name of readdirSync(WORKFLOWS_DIR)) if (name !== WORKFLOW_NAME && (name.endsWith(".yml") || name.endsWith(".yaml"))) others[name] = read(`.github/workflows/${name}`);
  return { pin: JSON.parse(read(`${BUILD_DIR}/guided-compile-inputs.pin.json`)) as Pin, buildPy: read(`${BUILD_DIR}/build.py`), dependencyList: read(`${BUILD_DIR}/dependencies.lst`), others, sourceWorkflow: read(`.github/workflows/${SOURCE_NAME}`), exists: (path) => existsSync(join(ROOT, path)) };
}

/** Every problem with this workflow text. Empty means every gate holds. */
export function violations(text: string, ctx: Context = loadContext()): string[] {
  const problems: string[] = [];
  const bad = (message: string) => problems.push(message);
  let doc: Doc;
  try { doc = yaml.parse(text) as Doc; } catch { return ["workflow does not parse"]; }
  const { pin } = ctx;

  // 1. Trigger: exactly one push of exactly one named, brand-new branch. Nothing a PR, a button, a tag or a clock can fire.
  const on = doc.on ?? {};
  if (JSON.stringify(Object.keys(on)) !== JSON.stringify(["push"])) bad(`on: must be exactly {push}, got ${Object.keys(on).join(",")}`);
  if (JSON.stringify(on.push ?? {}) !== JSON.stringify({ branches: [TRIGGER_BRANCH] })) bad("on.push must be exactly one literal branch and nothing else");
  if (pin.trigger.branch !== TRIGGER_BRANCH || pin.trigger.workflow !== WORKFLOW_NAME || pin.trigger.sourceWorkflow !== SOURCE_NAME) bad("pin file trigger record differs from the gate");
  for (const [name, other] of Object.entries(ctx.others)) if (other.includes(TRIGGER_BRANCH)) bad(`${name} names the trigger branch`);
  // A branch that already fired (or is frozen) is never named by this workflow, even as a prefix of the new one.
  for (const used of USED_BRANCHES) if (new RegExp(`${used.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w-])`).test(text)) bad(`workflow names a used branch: ${used}`);

  // 2. Least privilege, no secrets, no token, no sudo, no environment override below the workflow.
  if (JSON.stringify(doc.permissions) !== JSON.stringify({ contents: "read" })) bad("permissions must be exactly contents: read");
  const jobs = doc.jobs ?? {};
  if (Object.keys(jobs).length !== 1) bad("exactly one job");
  const job = Object.values(jobs)[0] ?? {};
  if (job.permissions !== undefined) bad("job must not override permissions");
  if (/secrets\.|GITHUB_TOKEN|github\.token|id-token|persist-credentials:\s*true/i.test(text)) bad("secrets/token/id-token/credential persistence");
  if (job.env !== undefined || (job.steps ?? []).some((s) => s.env !== undefined)) bad("env is only allowed at workflow level");
  if (/\bsudo\b/.test(text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"))) bad("sudo anywhere");
  if (/continue-on-error/.test(text)) bad("continue-on-error anywhere");

  // 3. The firing gate, every conjunct.
  const gate = job.if ?? "";
  for (const piece of [`github.repository == '${REPOSITORY}'`, "github.event_name == 'push'", `github.ref == 'refs/heads/${TRIGGER_BRANCH}'`, "github.event.created == true", "github.run_attempt == '1'"]) if (!gate.includes(piece)) bad(`job if lacks: ${piece}`);
  if (/\|\||\bor\b/.test(gate)) bad("job if must be a pure conjunction");
  if (job["runs-on"] !== "ubuntu-24.04-arm") bad("runs-on must be ubuntu-24.04-arm");
  if (typeof job["timeout-minutes"] !== "number" || job["timeout-minutes"] > 30) bad("bounded timeout required");

  // 4. Pinned actions only: exactly the allowed two, each the commit the pin file names.
  const steps = job.steps ?? [];
  for (const step of steps) {
    if (!step.uses) continue;
    const [action, ref] = step.uses.split("@");
    if (!ALLOWED_ACTIONS.has(action ?? "")) bad(`action not allowed: ${action}`);
    else if (!/^[0-9a-f]{40}$/.test(ref ?? "")) bad(`action not pinned to a full SHA: ${step.uses}`);
    else if (pin.actions[action as string] !== ref) bad(`action SHA differs from the pin file: ${step.uses}`);
  }
  if (/download-artifact|actions\/cache|setup-bun|setup-node|setup-python|pnpm\/action-setup/.test(text)) bad("unexpected action");

  // 5. Checkouts: four, each credential-free. The first is the pushed commit with full history (the arming guard reads
  //    it); the builder head is checked out by the guard itself, only after it passes.
  const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
  const expectedCheckouts = [
    { ref: "${{ github.sha }}", repository: undefined, path: undefined, depth: 0 },
    { ref: "${{ env.RUNTIME_SDK_HEAD }}", repository: "yanlingLabs/winter-runtime-sdk", path: "origins/runtime", depth: undefined },
    { ref: "${{ env.AGENT_SDK_HEAD }}", repository: "yanlingLabs/winter-agent-sdk", path: "origins/sdk", depth: undefined },
    { ref: "${{ env.WINTER_HEAD }}", repository: "yanlingLabs/winter", path: "origins/winter", depth: undefined },
  ];
  if (checkouts.length !== 4) bad("exactly four checkouts");
  checkouts.forEach((step, index) => {
    const want = expectedCheckouts[index];
    if (step.with?.["persist-credentials"] !== false) bad("every checkout must set persist-credentials: false");
    if (!want || step.with?.ref !== want.ref || step.with?.repository !== want.repository || step.with?.path !== want.path || step.with?.["fetch-depth"] !== want.depth) bad(`checkout ${index} is not the reviewed origin`);
    if (Object.keys(step.with ?? {}).some((key) => !["ref", "repository", "path", "fetch-depth", "persist-credentials"].includes(key))) bad("checkout has extra with: keys");
  });
  if (steps[0] !== checkouts[0] || steps[0]?.with?.["fetch-depth"] !== 0) bad("the first step must be the pushed-commit checkout with full history");
  const guardStep = steps[1];
  const guardLines = logicalLines(guardStep?.run ?? "");
  if (!guardStep || guardStep.run === undefined || steps.indexOf(guardStep) !== 1) bad("the arming guard must be the second step");
  for (const [label, line] of GUARD) if (!guardLines.includes(line)) bad(`arming guard lacks ${label}`);
  if (JSON.stringify(guardLines) !== JSON.stringify(GUARD.map(([, line]) => line))) bad("arming guard is not exactly the reviewed script");

  // 6. The env block is the pin file, line for line.
  const env = (doc.env ?? {}) as Record<string, unknown>;
  const wantEnv: Record<string, string> = {
    RUNTIME_SDK_HEAD: pin.origins.runtimeSdk.head, AGENT_SDK_HEAD: pin.origins.agentSdk.head, WINTER_HEAD: pin.origins.winterCore.head,
    BUN_VERSION: pin.bun.version, BUN_ARCHIVE_SHA256: pin.bun.archiveSha256, BUN_EXECUTABLE_SHA256: pin.bun.executableSha256, DEPENDENCY_LIST_SHA256: sha256(ctx.dependencyList),
  };
  if (JSON.stringify(Object.keys(env).sort()) !== JSON.stringify([...Object.keys(wantEnv), "BUILDER_HEAD"].sort())) bad("env keys must be exactly the reviewed pins");
  for (const [key, value] of Object.entries(wantEnv)) if (env[key] !== value) bad(`env ${key} differs from the pin file`);
  if (typeof env.BUILDER_HEAD !== "string" || !/^[0-9a-f]{40}$/.test(env.BUILDER_HEAD)) bad("BUILDER_HEAD must be a 40-hex commit (all zeros while unarmed)");
  for (const key of ["RUNTIME_SDK_HEAD", "AGENT_SDK_HEAD", "WINTER_HEAD"]) if (!/^[0-9a-f]{40}$/.test(String(env[key]))) bad(`${key} must be a full commit, never a branch name`);

  // 7. The dependency list is the pin file's rendering, and its hash is the env's.
  const rendered = pin.dependencies.packages.map((item) => `${item.sha512} ${item.id.replaceAll("/", "+")}.tgz ${item.url}\n`).join("");
  if (ctx.dependencyList !== rendered) bad("dependencies.lst is not the rendering of the pin file");
  if (ctx.dependencyList.split("\n").filter(Boolean).some((line) => !/^[0-9a-f]{128} [^ ]+\.tgz https:\/\/registry\.npmjs\.org\/[^ ]+$/.test(line))) bad("dependencies.lst has a line that is not a registry sha512 pin");

  // 8. The network: exactly the two reviewed curl commands, each followed by its strict checksum, nothing else.
  const runs = steps.filter((s) => s.run !== undefined);
  const lines = runs.flatMap((s) => logicalLines(s.run ?? ""));
  const commandText = lines.join("\n");
  if (/\b(wget|nc|ncat|ssh|scp|apt(-get)?|pip3?|npm|npx|pnpm|yarn|corepack|bun\s+(install|add|x)|git\s+(clone|fetch|pull|push|remote|submodule)|docker|gh)\b/.test(commandText.replace(/--tlsv1\.2/g, ""))) bad("a step reaches the network or installs something");
  const curls = lines.filter((l) => /^curl\b/.test(l));
  if (curls.length !== 2) bad("exactly two curl commands (Bun, and the dependency loop)");
  const bunCurl = curls.find((l) => l.includes("bun-v"));
  if (!bunCurl || !bunCurl.includes(`"${BUN_URL}"`)) bad("the Bun download URL must be the pinned release asset");
  if (!curls.some((l) => l.includes('"$dependency_url"'))) bad("the dependency loop must download only $dependency_url");
  for (const curl of curls) {
    if (!curl.includes("--fail") || !curl.includes("--proto '=https'") || !curl.includes("--tlsv1.2") || !/--max-filesize \d+/.test(curl) || !/--max-time \d+/.test(curl)) bad("every curl must be --fail, https-only, tls1.2, size- and time-bounded");
  }
  const at = (predicate: (line: string) => boolean) => lines.findIndex(predicate);
  const bunCurlAt = at((l) => l.startsWith("curl") && l.includes("bun-v"));
  const bunSumAt = at((l) => /"\$BUN_ARCHIVE_SHA256"/.test(l) && /sha256sum --check --strict -$/.test(l));
  const listSumAt = at((l) => /"\$DEPENDENCY_LIST_SHA256"/.test(l) && /sha256sum --check --strict -$/.test(l));
  const loopAt = at((l) => l.startsWith("while read -r"));
  const loopSumAt = at((l) => /"\$dependency_sha512"/.test(l) && /sha512sum --check --strict -$/.test(l));
  const doneAt = at((l) => l.startsWith("done <"));
  const bunExtractAt = at((l) => /acquire\.py bun /.test(l));
  const depsExtractAt = at((l) => /acquire\.py deps /.test(l));
  if (bunSumAt < 0) bad("the Bun zip needs a strict sha256 check against BUN_ARCHIVE_SHA256");
  if (listSumAt < 0) bad("the dependency list needs a strict sha256 check against DEPENDENCY_LIST_SHA256");
  if (loopSumAt < 0) bad("each dependency tarball needs a strict sha512 check");
  if (bunCurlAt >= 0 && bunSumAt >= 0 && bunExtractAt >= 0 && !(bunCurlAt < bunSumAt && bunSumAt < bunExtractAt)) bad("order must be Bun download, its checksum, then unpack");
  if (listSumAt >= 0 && loopAt >= 0 && loopSumAt >= 0 && doneAt >= 0 && depsExtractAt >= 0 && !(listSumAt < loopAt && loopAt < loopSumAt && loopSumAt < doneAt && doneAt < depsExtractAt)) bad("order must be list checksum, download loop with per-file checksum, then unpack");
  if (bunExtractAt < 0 || depsExtractAt < 0) bad("both acquire.py unpack steps are required");

  // 9. Nothing is executed: every shell line is a reviewed shape, and no execution or privilege word appears at all.
  for (const line of lines) {
    if (line === CC_LINE || GUARD.some(([, guardLine]) => guardLine === line)) continue;
    if (!SHAPES.some((shape) => shape.test(line))) bad(`unreviewed command line: ${line}`);
  }
  if (!lines.includes(CC_LINE)) bad("the native compiler path must be resolved exactly as reviewed");
  if (/(^|[\s;&|(])(\.\/|bash\b|sh\s+-c|exec\b|nohup|chmod|chown|setsid|qemu|ldd\b|strace|valgrind|timeout\s)/m.test(commandText)) bad("an execution or privilege command appears");
  if (/\$(\{?GUIDED_FIXTURE\}?|guided_fixture)\/(packet\/)?artifacts\/\w+[^.]/.test(commandText) || /"\$GUIDED_FIXTURE\/packet\/(artifacts|environment|stage)/.test(commandText)) bad("a compiled output path appears in a command");

  // 10. The build step is build.py with exactly its own flags; unpack steps use the reviewed script.
  const build = lines.find((l) => l.includes("scripts/guest-guided-build/build.py")) ?? "";
  const flags = buildFlags(ctx.buildPy);
  const given = [...build.matchAll(/ (--[a-z-]+)/g)].map((m) => m[1] as string).sort();
  if (!build.startsWith("python3 -I -S -B scripts/guest-guided-build/build.py")) bad("build.py must run as python3 -I -S -B scripts/guest-guided-build/build.py");
  if (JSON.stringify(given) !== JSON.stringify(flags.required)) bad(`build flags differ from build.py's argparse: ${given.join(",")} vs ${flags.required.join(",")}`);
  if (!build.includes('--builder-head "$BUILDER_HEAD"')) bad("the build must receive the builder head from the env pin");
  if (!build.includes('--workflow-head "$GITHUB_SHA"')) bad("the build must record the workflow head");
  if (!build.includes("--sysroot /")) bad("the build reads native libraries from the runner sysroot");
  if (!ctx.exists(`${BUILD_DIR}/acquire.py`) || !ctx.exists(`${BUILD_DIR}/build.py`)) bad("the reviewed scripts must exist");

  // 11. Result: exactly two uploads, 7 days each, the first on success only, the second diagnostics on failure only.
  const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
  if (uploads.length !== 2) bad("exactly two uploads");
  const [packet, diagnostics] = uploads;
  if (packet?.if !== undefined) bad("the packet upload must run on success only (no if:)");
  if (JSON.stringify(Object.keys(packet?.with ?? {}).sort()) !== JSON.stringify(["if-no-files-found", "name", "path", "retention-days"])) bad("packet upload keys");
  if (packet?.with?.path !== "${{ env.GUIDED_FIXTURE }}/archive/guided-packet.tar.gz\n${{ env.GUIDED_FIXTURE }}/archive/packet-inventory.json\n") bad("packet upload must carry only the archive and its inventory");
  if (packet?.with?.["if-no-files-found"] !== "error") bad("packet upload must fail when files are missing");
  if (diagnostics?.if !== "failure() && env.GUIDED_FIXTURE != ''") bad("diagnostics upload must run on failure only");
  if (diagnostics?.with?.path !== "${{ env.GUIDED_FIXTURE }}/packet/diagnostics/*.json\n${{ env.GUIDED_FIXTURE }}/packet/artifacts/*.metafile.json\n${{ env.GUIDED_FIXTURE }}/acquisition.json\n") bad("diagnostics upload must carry only bounded records");
  if (diagnostics?.with?.["if-no-files-found"] !== "ignore") bad("diagnostics upload must tolerate absent files");
  for (const upload of uploads) if (upload.with?.["retention-days"] !== 7 || pin.retentionDays !== 7) bad("retention must be 7 days");
  if (uploads.length === 2 && steps[steps.length - 1] !== diagnostics) bad("diagnostics upload is the last step");
  const buildStepAt = steps.findIndex((s) => (s.run ?? "").includes("scripts/guest-guided-build/build.py"));
  const fetchAt = steps.findIndex((s) => (s.run ?? "").includes("acquire.py"));
  if (!(fetchAt >= 0 && fetchAt < buildStepAt && buildStepAt < steps.indexOf(packet as Step) && steps.indexOf(packet as Step) < steps.indexOf(diagnostics as Step))) bad("order must be checkouts, fetch, build, packet upload, diagnostics upload");
  return problems;
}

describe("guided packet compile-fixture workflow gates", () => {
  const WORKFLOW = read(`.github/workflows/${WORKFLOW_NAME}`);

  test("the committed workflow satisfies every gate", () => {
    expect(violations(WORKFLOW)).toEqual([]);
  });

  test("the trigger branch is new: not a reader, hosted or builder-source branch", () => {
    expect(USED_BRANCHES).not.toContain(TRIGGER_BRANCH);
    expect(TRIGGER_BRANCH).toBe("cowork/guided-packet-compile-fixture-2");
  });

  test("the trigger is the exact first-creation push of one new branch, and nothing else", () => {
    const doc = yaml.parse(WORKFLOW) as Doc;
    expect(doc.on).toEqual({ push: { branches: [TRIGGER_BRANCH] } });
    for (const name of ["pull_request", "pull_request_target", "workflow_dispatch", "schedule", "workflow_run", "repository_dispatch", "release", "issue_comment"]) expect(Object.keys(doc.on ?? {})).not.toContain(name);
  });

  test("the trigger branch is absent from every other workflow and from the pin file's other records", () => {
    for (const [name, text] of Object.entries(loadContext().others)) expect([name, text.includes(TRIGGER_BRANCH)]).toEqual([name, false]);
  });

  test("the source workflow checks data only: no compiler, no download, no output", () => {
    const doc = yaml.parse(loadContext().sourceWorkflow) as Doc;
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(Object.keys(doc.jobs ?? {})).toEqual(["portable-data"]);
    const steps = doc.jobs?.["portable-data"]?.steps ?? [];
    expect(steps.map((s) => s.run ?? s.uses)).toEqual([`actions/checkout@${loadContext().pin.actions["actions/checkout"]}`, "python3 -I -S -B scripts/guest-guided-build/test_guided_build.py"]);
    expect(steps[0]?.with).toEqual({ "persist-credentials": false });
    expect(JSON.stringify(doc.on)).not.toContain(TRIGGER_BRANCH);
  });

  test("the builder README states the run is untriggered, names the trigger and leaves the Bun choice and the run to the owner", () => {
    const readme = read(`${BUILD_DIR}/README.md`);
    expect(readme).toContain(TRIGGER_BRANCH);
    expect(readme).toContain("never triggered");
    expect(readme).toContain("The owner chooses the Bun version");
    expect(readme).toContain("approves the");
    expect(readme).toContain("single run");
    expect(readme.toLowerCase()).toContain("frozen");
    expect(readme).toContain("if an automated safety flag fires on follow-on work, that work stops and is surfaced to the owner, never reworded or rerouted.");
    expect(readme).not.toMatch(/C59 (is|was) explained/i);
  });
});

// Each entry removes or breaks exactly one gate. Every one must make `violations` contain its own named message.
const sub = (from: string | RegExp, to: string) => (t: string) => t.replace(from, to);
const SHA_CHECKOUT = /actions\/checkout@[0-9a-f]{40}/;
const MUTATIONS: Array<[string, (text: string) => string, string]> = [
  ["add pull_request trigger", sub("on:\n  push:", "on:\n  pull_request:\n  push:"), "on: must be exactly {push}, got pull_request,push"],
  ["add pull_request_target trigger", sub("on:\n  push:", "on:\n  pull_request_target:\n  push:"), "on: must be exactly {push}, got pull_request_target,push"],
  ["add workflow_dispatch trigger", sub("on:\n  push:", "on:\n  workflow_dispatch:\n  push:"), "on: must be exactly {push}, got workflow_dispatch,push"],
  ["add schedule trigger", sub("on:\n  push:", "on:\n  schedule:\n    - cron: '0 0 * * *'\n  push:"), "on: must be exactly {push}, got schedule,push"],
  ["add workflow_run trigger", sub("on:\n  push:", "on:\n  workflow_run:\n    workflows: [ci]\n  push:"), "on: must be exactly {push}, got workflow_run,push"],
  ["widen the branch to a glob", sub(`[${TRIGGER_BRANCH}]`, "['cowork/**']"), "on.push must be exactly one literal branch and nothing else"],
  ["add a tags filter", sub("  push:\n    branches:", "  push:\n    tags: ['*']\n    branches:"), "on.push must be exactly one literal branch and nothing else"],
  ["add a paths filter", sub(`branches: [${TRIGGER_BRANCH}]`, `branches: [${TRIGGER_BRANCH}]\n    paths: ['scripts/**']`), "on.push must be exactly one literal branch and nothing else"],
  ["reuse the frozen first-run branch", (t) => t.replaceAll(TRIGGER_BRANCH, "cowork/guided-packet-compile-fixture"), "workflow names a used branch: cowork/guided-packet-compile-fixture"],
  ["swap to a previously used branch", (t) => t.replaceAll(TRIGGER_BRANCH, "cowork/instruction-reader-compile-fixture"), "on.push must be exactly one literal branch and nothing else"],
  ["drop the repository gate", sub(`github.repository == '${REPOSITORY}' && `, ""), `job if lacks: github.repository == '${REPOSITORY}'`],
  ["drop the event-name gate", sub("github.event_name == 'push' && ", ""), "job if lacks: github.event_name == 'push'"],
  ["drop the exact-ref gate", sub(` && github.ref == 'refs/heads/${TRIGGER_BRANCH}'`, ""), `job if lacks: github.ref == 'refs/heads/${TRIGGER_BRANCH}'`],
  ["drop the first-creation gate", sub(" && github.event.created == true", ""), "job if lacks: github.event.created == true"],
  ["drop the run_attempt gate", sub(" && github.run_attempt == '1'", ""), "job if lacks: github.run_attempt == '1'"],
  ["turn the gate into a disjunction", sub("github.event.created == true &&", "github.event.created == true ||"), "job if must be a pure conjunction"],
  ["remove the job if entirely", sub(/    if: .*\n/, ""), `job if lacks: github.repository == '${REPOSITORY}'`],
  ["wrong runner", sub("ubuntu-24.04-arm", "ubuntu-latest"), "runs-on must be ubuntu-24.04-arm"],
  ["no timeout", sub("    timeout-minutes: 30\n", ""), "bounded timeout required"],
  ["unbounded timeout", sub("timeout-minutes: 30", "timeout-minutes: 360"), "bounded timeout required"],
  ["drop top-level permissions", sub("permissions:\n  contents: read\n", ""), "permissions must be exactly contents: read"],
  ["widen permissions", sub("contents: read", "contents: write"), "permissions must be exactly contents: read"],
  ["add id-token permission", sub("contents: read", "contents: read\n  id-token: write"), "permissions must be exactly contents: read"],
  ["job-level permission override", sub("    runs-on:", "    permissions:\n      contents: read\n    runs-on:"), "job must not override permissions"],
  ["unpin checkout", sub(SHA_CHECKOUT, "actions/checkout@v4"), "action not pinned to a full SHA: actions/checkout@v4"],
  ["unpin upload-artifact", sub(/actions\/upload-artifact@[0-9a-f]{40}/, "actions/upload-artifact@v4"), "action not pinned to a full SHA: actions/upload-artifact@v4"],
  ["pin checkout to another commit", sub(SHA_CHECKOUT, `actions/checkout@${"1".repeat(40)}`), "action SHA differs from the pin file"],
  ["an unlisted action", sub("      - name: Fetch", `      - uses: actions/cache@${"2".repeat(40)}\n      - name: Fetch`), "action not allowed: actions/cache"],
  ["a package-manager action", sub("      - name: Fetch", `      - uses: pnpm/action-setup@${"3".repeat(40)}\n      - name: Fetch`), "unexpected action"],
  ["checkout keeps credentials", sub("persist-credentials: false", "persist-credentials: true"), "every checkout must set persist-credentials: false"],
  ["checkout drops credential setting", sub("          fetch-depth: 0\n          persist-credentials: false\n", "          fetch-depth: 0\n"), "every checkout must set persist-credentials: false"],
  ["checkout a mutable ref", sub("ref: ${{ env.WINTER_HEAD }}", "ref: cowork/output-integration"), "checkout 3 is not the reviewed origin"],
  ["checkout the wrong repository", sub("repository: yanlingLabs/winter\n", "repository: someone/else\n"), "checkout 3 is not the reviewed origin"],
  ["checkout into the wrong path", sub("path: origins/sdk", "path: origins/other"), "checkout 2 is not the reviewed origin"],
  ["checkout fetches submodules", sub("          path: origins/winter\n", "          path: origins/winter\n          submodules: recursive\n"), "checkout has extra with: keys"],
  ["fifth checkout", sub("      - name: Fetch", `      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n        with:\n          persist-credentials: false\n      - name: Fetch`), "exactly four checkouts"],
  ["use a secret", sub("        shell: bash\n        run: |\n          set -euo pipefail\n          guided_cc", "        shell: bash\n        env:\n          K: ${{ secrets.K }}\n        run: |\n          set -euo pipefail\n          guided_cc"), "secrets/token/id-token/credential persistence"],
  ["step-level env override", sub("        shell: bash\n        run: |\n          set -euo pipefail\n          guided_cc", "        shell: bash\n        env:\n          BUN_VERSION: '9.9.9'\n        run: |\n          set -euo pipefail\n          guided_cc"), "env is only allowed at workflow level"],
  ["job-level env override", sub("    timeout-minutes: 30\n", "    timeout-minutes: 30\n    env:\n      BUN_VERSION: '9.9.9'\n"), "env is only allowed at workflow level"],
  ["sudo in a step", sub("          set -euo pipefail\n          guided_cc", "          set -euo pipefail\n          sudo -n true\n          guided_cc"), "sudo anywhere"],
  ["continue-on-error on the build", sub("      - name: Compile guided roles", "      - continue-on-error: true\n        name: Compile guided roles"), "continue-on-error anywhere"],
  ["builder head not a commit", sub(`BUILDER_HEAD: '${ZERO_HEAD}'`, "BUILDER_HEAD: main"), "BUILDER_HEAD must be a 40-hex commit"],
  ["a head becomes a branch name", sub(/WINTER_HEAD: [0-9a-f]{40}/, "WINTER_HEAD: cowork/output-integration"), "WINTER_HEAD must be a full commit, never a branch name"],
  ["agent-sdk head drifts from the pin file", sub(/AGENT_SDK_HEAD: [0-9a-f]{40}/, `AGENT_SDK_HEAD: ${"4".repeat(40)}`), "env AGENT_SDK_HEAD differs from the pin file"],
  ["runtime-sdk head drifts from the pin file", sub(/RUNTIME_SDK_HEAD: [0-9a-f]{40}/, `RUNTIME_SDK_HEAD: ${"5".repeat(40)}`), "env RUNTIME_SDK_HEAD differs from the pin file"],
  ["winter head drifts from the pin file", sub(/WINTER_HEAD: [0-9a-f]{40}/, `WINTER_HEAD: ${"6".repeat(40)}`), "env WINTER_HEAD differs from the pin file"],
  ["Bun version drifts", sub("BUN_VERSION: '1.3.14'", "BUN_VERSION: '1.4.2'"), "env BUN_VERSION differs from the pin file"],
  ["Bun archive hash drifts", sub(/BUN_ARCHIVE_SHA256: [0-9a-f]{64}/, `BUN_ARCHIVE_SHA256: ${"0".repeat(64)}`), "env BUN_ARCHIVE_SHA256 differs from the pin file"],
  ["Bun executable hash drifts", sub(/BUN_EXECUTABLE_SHA256: [0-9a-f]{64}/, `BUN_EXECUTABLE_SHA256: ${"0".repeat(64)}`), "env BUN_EXECUTABLE_SHA256 differs from the pin file"],
  ["dependency list hash drifts", sub(/DEPENDENCY_LIST_SHA256: [0-9a-f]{64}/, `DEPENDENCY_LIST_SHA256: ${"0".repeat(64)}`), "env DEPENDENCY_LIST_SHA256 differs from the pin file"],
  ["an unreviewed env key", sub("  BUN_VERSION:", "  EXTRA: 1\n  BUN_VERSION:"), "env keys must be exactly the reviewed pins"],
  ["Bun URL points elsewhere", sub("github.com/oven-sh/bun/releases", "example.invalid/bun/releases"), "the Bun download URL must be the pinned release asset"],
  ["Bun download drops --fail", sub(/curl --fail (--location --proto '=https' --tlsv1\.2 --max-time 120 --max-filesize 134217728)/, "curl $1"), "every curl must be --fail, https-only, tls1.2, size- and time-bounded"],
  ["Bun download allows plain http", sub("--proto '=https' --tlsv1.2 --max-time 120 --max-filesize 134217728", "--max-time 120 --max-filesize 134217728"), "every curl must be --fail, https-only, tls1.2, size- and time-bounded"],
  ["Bun download loses its size bound", sub(" --max-filesize 134217728", ""), "every curl must be --fail, https-only, tls1.2, size- and time-bounded"],
  ["a third curl", sub("          set -euo pipefail\n          guided_fixture", "          set -euo pipefail\n          curl --fail --proto '=https' --tlsv1.2 --max-time 1 --max-filesize 1 \"https://example.invalid/x\" --output \"$HOME/x\"\n          guided_fixture"), "exactly two curl commands"],
  ["dependency loop downloads another URL", sub('"$dependency_url" --output', '"https://example.invalid/x" --output'), "the dependency loop must download only $dependency_url"],
  ["Bun checksum removed", sub(/ *printf '%s  %s\\n' "\$BUN_ARCHIVE_SHA256"[^\n]*\n/, ""), "the Bun zip needs a strict sha256 check against BUN_ARCHIVE_SHA256"],
  ["Bun checksum not strict", sub(/(BUN_ARCHIVE_SHA256[^\n]*sha256sum --check) --strict/, "$1"), "the Bun zip needs a strict sha256 check against BUN_ARCHIVE_SHA256"],
  ["Bun checksum after unpack", (t) => { const m = /( *printf '%s  %s\\n' "\$BUN_ARCHIVE_SHA256"[^\n]*\n)/.exec(t)!; return t.replace(m[1]!, "").replace(/( *python3 -I -S -B scripts\/guest-guided-build\/acquire\.py deps[^\n]*\n)/, `${m[1]}$1`).replace(/( *python3 -I -S -B scripts\/guest-guided-build\/acquire\.py bun[^\n]*\n)/, `$1${m[1]}`); }, "order must be Bun download, its checksum, then unpack"],
  ["list checksum removed", sub(/ *printf '%s  %s\\n' "\$DEPENDENCY_LIST_SHA256"[^\n]*\n/, ""), "the dependency list needs a strict sha256 check against DEPENDENCY_LIST_SHA256"],
  ["per-file checksum removed", sub(/ *printf '%s  %s\\n' "\$dependency_sha512"[^\n]*\n/, ""), "each dependency tarball needs a strict sha512 check"],
  ["per-file checksum not strict", sub("sha512sum --check --strict -", "sha512sum --check -"), "each dependency tarball needs a strict sha512 check"],
  ["bun unpack removed", sub(/ *python3 -I -S -B scripts\/guest-guided-build\/acquire\.py bun[^\n]*\n/, ""), "both acquire.py unpack steps are required"],
  ["deps unpack removed", sub(/ *python3 -I -S -B scripts\/guest-guided-build\/acquire\.py deps[^\n]*\n/, ""), "both acquire.py unpack steps are required"],
  ["a package manager install", sub("          set -euo pipefail\n          guided_cc", "          set -euo pipefail\n          pnpm install --frozen-lockfile\n          guided_cc"), "a step reaches the network or installs something"],
  ["bun install", sub("          set -euo pipefail\n          guided_cc", "          set -euo pipefail\n          bun install\n          guided_cc"), "a step reaches the network or installs something"],
  ["executes an output", sub("          guided_cc=", "          \"$GUIDED_FIXTURE/packet/artifacts/hostClient\"\n          guided_cc="), "unreviewed command line"],
  ["executes an output by relative path", sub("          guided_cc=", "          ./hostClient\n          guided_cc="), "an execution or privilege command appears"],
  ["chmod then run", sub("          guided_cc=", "          chmod +x x\n          guided_cc="), "an execution or privilege command appears"],
  ["runs under qemu", sub("          guided_cc=", "          qemu-aarch64 x\n          guided_cc="), "an execution or privilege command appears"],
  ["an extra unreviewed command", sub("          guided_cc=", "          echo hello\n          guided_cc="), "unreviewed command line: echo hello"],
  ["native compiler resolved another way", sub(CC_LINE, "guided_cc=/usr/bin/cc"), "the native compiler path must be resolved exactly as reviewed"],
  ["build drops -I", sub("python3 -I -S -B scripts/guest-guided-build/build.py", "python3 scripts/guest-guided-build/build.py"), "build.py must run as python3 -I -S -B scripts/guest-guided-build/build.py"],
  ["build flag removed", sub(' \\\n            --archive-dir "$GUIDED_FIXTURE/archive" --acquisition "$GUIDED_FIXTURE/acquisition.json"', ""), "build flags differ from build.py's argparse"],
  ["build gains a flag build.py lacks", sub('--workflow-head "$GITHUB_SHA"', '--workflow-head "$GITHUB_SHA" --resolver-map "$GUIDED_FIXTURE/resolver-map.json"'), "build flags differ from build.py's argparse"],
  ["build head not from the env pin", sub('--builder-head "$BUILDER_HEAD"', `--builder-head "${"7".repeat(40)}"`), "the build must receive the builder head from the env pin"],
  ["build stops recording the workflow head", sub('--workflow-head "$GITHUB_SHA"', '--workflow-head "x"'), "the build must record the workflow head"],
  ["build loses the sysroot", sub("--sysroot / ", ""), "the build reads native libraries from the runner sysroot"],
  ["upload loses its success-only default", sub("      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: guided-packet-compile", "      - if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: guided-packet-compile"), "the packet upload must run on success only (no if:)"],
  ["packet upload carries the whole packet", sub("${{ env.GUIDED_FIXTURE }}/archive/guided-packet.tar.gz", "${{ env.GUIDED_FIXTURE }}/packet/"), "packet upload must carry only the archive and its inventory"],
  ["packet upload tolerates no files", sub("if-no-files-found: error", "if-no-files-found: ignore"), "packet upload must fail when files are missing"],
  ["packet upload gains a key", sub("          if-no-files-found: error\n", "          if-no-files-found: error\n          compression-level: 0\n"), "packet upload keys"],
  ["diagnostics upload runs always", sub("failure() && env.GUIDED_FIXTURE != ''", "always()"), "diagnostics upload must run on failure only"],
  ["diagnostics carry the packet", sub("${{ env.GUIDED_FIXTURE }}/packet/diagnostics/*.json", "${{ env.GUIDED_FIXTURE }}/packet/**"), "diagnostics upload must carry only bounded records"],
  ["diagnostics fail without files", sub("if-no-files-found: ignore", "if-no-files-found: error"), "diagnostics upload must tolerate absent files"],
  ["packet retention 90 days", sub("          if-no-files-found: error\n          retention-days: 7", "          if-no-files-found: error\n          retention-days: 90"), "retention must be 7 days"],
  ["diagnostics retention 30 days", sub("          if-no-files-found: ignore\n          retention-days: 7", "          if-no-files-found: ignore\n          retention-days: 30"), "retention must be 7 days"],
  ["a third upload", (t) => `${t}      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          name: extra\n          path: out/\n          retention-days: 7\n`, "exactly two uploads"],
  ["two jobs", (t) => `${t}  second:\n    runs-on: ubuntu-24.04-arm\n    steps: []\n`, "exactly one job"],
  ["list checksum moves after the loop", (t) => { const m = /( *printf '%s  %s\\n' "\$DEPENDENCY_LIST_SHA256"[^\n]*\n)/.exec(t)!; return t.replace(m[1]!, "").replace(/( *python3 -I -S -B scripts\/guest-guided-build\/acquire\.py deps[^\n]*\n)/, `$1${m[1]}`); }, "order must be list checksum, download loop with per-file checksum, then unpack"],
  ["a command names a compiled output path", sub("          guided_cc=", "          printf '%s' \"$GUIDED_FIXTURE/packet/artifacts/hostClient\"\n          guided_cc="), "a compiled output path appears in a command"],
  ["a trailing step after the diagnostics upload", (t) => `${t}      - run: printf 'x'\n`, "diagnostics upload is the last step"],
  ["guard: unarmed refusal removed", sub(/ *test "\$BUILDER_HEAD" != "0+"\n/, ""), "arming guard lacks the unarmed refusal"],
  ["guard: ancestor check removed", sub(/ *git merge-base --is-ancestor[^\n]*\n/, ""), "arming guard lacks the ancestor check"],
  ["guard: ancestor check made advisory", sub('"$GITHUB_SHA"\n          test "$(git diff --name-only', '"$GITHUB_SHA" || true\n          test "$(git diff --name-only'), "arming guard lacks the ancestor check"],
  ["guard: single-file check removed", sub(/ *test "\$\(git diff --name-only[^\n]*\n/, ""), "arming guard lacks the single-file check"],
  ["guard: single-file check allows a second file", sub('= ".github/workflows/cowork-guided-packet-compile-fixture.yml"', '!= ""'), "arming guard lacks the single-file check"],
  ["guard: numstat check removed", sub(/ *test "\$\(git diff --numstat[^\n]*\n/, ""), "arming guard lacks the numstat check"],
  ["guard: numstat check allows two added lines", sub("'1\\t1\\t%s'", "'2\\t1\\t%s'"), "arming guard lacks the numstat check"],
  ["guard: diff capture removed", sub(/ *armed_diff=\$\([^\n]*\n/, ""), "arming guard lacks the diff capture"],
  ["guard: one-line diff check removed", sub(/ *test "\$armed_diff"[^\n]*\n/, ""), "arming guard lacks the exact one-line diff check"],
  ["guard: one-line diff check accepts two lines", sub("grep -E '^[-+][^-+]'", "grep -E '^[+][^+]'"), "arming guard lacks the diff capture"],
  ["guard: builder-head checkout removed", sub(/ *git checkout --detach --quiet[^\n]*\n/, ""), "arming guard lacks the builder-head checkout"],
  ["guard: an extra line after the checkout", sub('git checkout --detach --quiet "$BUILDER_HEAD"\n', 'git checkout --detach --quiet "$BUILDER_HEAD"\n          git submodule update --init\n'), "arming guard is not exactly the reviewed script"],
  ["guard step removed", sub(/      - name: Refuse any arming commit[\s\S]*?git checkout --detach --quiet "\$BUILDER_HEAD"\n/, ""), "the arming guard must be the second step"],
  ["pushed checkout is shallow", sub("          fetch-depth: 0\n", ""), "the first step must be the pushed-commit checkout with full history"],
  ["pushed checkout of a mutable ref", sub("ref: ${{ github.sha }}", "ref: main"), "checkout 0 is not the reviewed origin"],
  ["builder checkout reappears before the guard", sub("    steps:\n", "    steps:\n      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5\n        with:\n          ref: ${{ env.BUILDER_HEAD }}\n          persist-credentials: false\n"), "the first step must be the pushed-commit checkout with full history"],
  ["uploads reordered after a trailing step", (t) => `${t}      - run: printf 'x'\n`, "unreviewed command line"],
  ["build before fetch", (t) => { const parts = t.split("      - name: "); return [parts[0], parts[1], parts[3], parts[2], ...parts.slice(4)].join("      - name: "); }, "order must be checkouts, fetch, build, packet upload, diagnostics upload"],
];

// A mutation is only evidence if it changed the text and was caught by the violation it names.
describe("guided packet compile-fixture workflow gate mutations", () => {
  const WORKFLOW = read(`.github/workflows/${WORKFLOW_NAME}`);
  const ctx = loadContext();
  test("the table has one entry per gate it claims and no duplicate names", () => {
    expect(new Set(MUTATIONS.map(([name]) => name)).size).toBe(MUTATIONS.length);
    expect(MUTATIONS.length).toBeGreaterThanOrEqual(80);
  });
  for (const [name, mutate, expected] of MUTATIONS) {
    test(`mutation caught by its own gate: ${name}`, () => {
      const mutated = mutate(WORKFLOW);
      expect(mutated).not.toBe(WORKFLOW);
      const found = violations(mutated, ctx);
      expect(found.some((message) => message.includes(expected))).toBe(true);
    });
  }
  test("every gate message in violations() is exercised by a mutation or by the cross-check test below", () => {
    const source = readFileSync(import.meta.path, "utf8");
    const body = source.slice(source.indexOf("export function violations"), source.indexOf('describe("guided packet compile-fixture workflow gates"'));
    const messages = [...body.matchAll(/bad\((["`])((?:\\.|(?!\1).)*)\1\)/g)].map((m) => (m[2] as string).split("${")[0] as string);
    const crossChecks = ["dependencies.lst has a line that is not a registry sha512 pin", "the reviewed scripts must exist", "dependencies.lst is not the rendering of the pin file", "pin file trigger record differs from the gate", "retention must be 7 days", " names the trigger branch", "build flags differ from build.py's argparse"];
    const uncovered = messages.filter((message) => message.length > 0 && !MUTATIONS.some(([, , expected]) => expected.includes(message) || message.includes(expected)) && !crossChecks.some((c) => c.includes(message) || message.includes(c)));
    expect(uncovered).toEqual([]);
    expect(messages.length).toBeGreaterThan(60);
  });
  test("a drifted dependency list or pin file is caught by the cross-checks", () => {
    expect(violations(WORKFLOW, { ...ctx, dependencyList: ctx.dependencyList.replace(/[0-9a-f]/, (c) => (c === "0" ? "1" : "0")) }).join("\n")).toContain("dependencies.lst is not the rendering of the pin file");
    expect(violations(WORKFLOW, { ...ctx, pin: { ...ctx.pin, trigger: { ...ctx.pin.trigger, branch: "cowork/other" } } }).join("\n")).toContain("pin file trigger record differs from the gate");
    expect(violations(WORKFLOW, { ...ctx, pin: { ...ctx.pin, retentionDays: 30 } }).join("\n")).toContain("retention must be 7 days");
    expect(violations(WORKFLOW, { ...ctx, others: { "ci.yml": `on: push\n# ${TRIGGER_BRANCH}\n` } }).join("\n")).toContain("ci.yml names the trigger branch");
    const badUrlPin = { ...ctx.pin, dependencies: { packages: ctx.pin.dependencies.packages.map((item, i) => (i === 0 ? { ...item, url: "http://registry.npmjs.org/x" } : item)) } };
    const badUrlList = badUrlPin.dependencies.packages.map((item) => `${item.sha512} ${item.id.replaceAll("/", "+")}.tgz ${item.url}\n`).join("");
    expect(violations(WORKFLOW, { ...ctx, pin: badUrlPin, dependencyList: badUrlList }).join("\n")).toContain("dependencies.lst has a line that is not a registry sha512 pin");
    expect(violations(WORKFLOW, { ...ctx, exists: () => false }).join("\n")).toContain("the reviewed scripts must exist");
    expect(violations(WORKFLOW, { ...ctx, buildPy: ctx.buildPy.replace("'archive-dir',", "") }).join("\n")).toContain("build flags differ from build.py's argparse");
  });
});

// The guard is run for real, as bash, against throwaway Git repositories: each way an arming commit can be wrong must fail.
describe("arming guard behaviour (runs the workflow's own guard script against temporary repositories)", () => {
  const doc = yaml.parse(read(`.github/workflows/${WORKFLOW_NAME}`)) as Doc;
  const script = (Object.values(doc.jobs ?? {})[0]?.steps ?? [])[1]?.run ?? "";
  const workflow = (head: string, extra = "") => `name: x\nenv:\n  BUILDER_HEAD: '${head}'\n  OTHER: 1\n${extra}`;
  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  }
  /** Builds: builder commit B (unarmed workflow), then a pushed commit C produced by `arm`. Returns the guard's exit status. */
  function run(arm: (dir: string, builder: string) => string | void, options: { headOverride?: (builder: string, dir: string) => string } = {}): number {
    const dir = mkdtempSync(join(tmpdir(), "guided-arming-guard-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(join(dir, WORKFLOW_PATH), workflow(ZERO_HEAD));
      writeFileSync(join(dir, "builder.txt"), "builder\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "builder");
      const builder = git(dir, "rev-parse", "HEAD");
      const head = arm(dir, builder) ?? builder;
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "arming");
      const pushed = git(dir, "rev-parse", "HEAD");
      const builderHead = options.headOverride ? options.headOverride(builder, dir) : head;
      return spawnSync("bash", ["-c", script], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", BUILDER_HEAD: builderHead, GITHUB_SHA: pushed } }).status ?? -1;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const armLine = (dir: string, builder: string) => { writeFileSync(join(dir, WORKFLOW_PATH), workflow(builder)); return builder; };

  test("the extracted script is the guard under test", () => {
    expect(script).toContain("git merge-base --is-ancestor");
  });
  test("an arming commit that changes exactly the BUILDER_HEAD line passes", () => {
    expect(run(armLine)).toBe(0);
  });
  test("unarmed (all zeros) still fails closed", () => {
    expect(run((dir, builder) => { writeFileSync(join(dir, "note.txt"), "x"); return ZERO_HEAD; })).not.toBe(0);
  });
  test("caught: an arming commit with an extra file change (an empty file adds no diff line, so only the file-list check sees it)", () => {
    expect(run((dir, builder) => { armLine(dir, builder); writeFileSync(join(dir, "extra-empty-file"), ""); return builder; })).not.toBe(0);
  });
  test("caught: an arming commit that also edits the builder files in place", () => {
    expect(run((dir, builder) => { armLine(dir, builder); writeFileSync(join(dir, "builder.txt"), "changed\n"); return builder; })).not.toBe(0);
  });
  test("caught: a BUILDER_HEAD that is not an ancestor of the pushed commit, with an otherwise perfect one-line diff", () => {
    // S has exactly the builder commit's tree but is unrelated to the pushed history; the diff S..pushed is the one reviewed line.
    expect(run((dir, builder) => { const side = git(dir, "commit-tree", `${builder}^{tree}`, "-m", "side"); writeFileSync(join(dir, WORKFLOW_PATH), workflow(side)); return side; })).not.toBe(0);
    // Control: the same shape with an ancestor passes, so the failure above is the ancestry and nothing else.
    expect(run((dir, builder) => { const child = git(dir, "commit-tree", `${builder}^{tree}`, "-p", builder, "-m", "child"); git(dir, "reset", "-q", "--soft", child); writeFileSync(join(dir, WORKFLOW_PATH), workflow(child)); return child; })).toBe(0);
  });
  test("caught by the numstat check alone: the arming commit also adds a `---` line, which the changed-line filter cannot see", () => {
    expect(run((dir, builder) => { writeFileSync(join(dir, WORKFLOW_PATH), `${workflow(builder)}---\n`); return builder; })).not.toBe(0);
  });
  test("caught by the numstat check alone: the arming commit also adds a line starting with a plus", () => {
    expect(run((dir, builder) => { writeFileSync(join(dir, WORKFLOW_PATH), `${workflow(builder)}+x\n`); return builder; })).not.toBe(0);
  });
  test("caught: a two-line diff (the BUILDER_HEAD line plus another line of the workflow)", () => {
    expect(run((dir, builder) => { writeFileSync(join(dir, WORKFLOW_PATH), workflow(builder).replace("OTHER: 1", "OTHER: 2")); return builder; })).not.toBe(0);
  });
  test("caught: a BUILDER_HEAD line written with different spelling than the reviewed one", () => {
    expect(run((dir, builder) => { writeFileSync(join(dir, WORKFLOW_PATH), workflow(builder).replace(`'${builder}'`, builder)); return builder; })).not.toBe(0);
  });
  test("caught: an arming commit that arms to a commit other than the recorded builder head", () => {
    expect(run(armLine, { headOverride: () => "1".repeat(40) })).not.toBe(0);
  });
});
