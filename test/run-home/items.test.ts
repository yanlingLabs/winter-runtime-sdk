// WS-21 §3.3, §3.4.1-2, §3.2: the item merge — claude's clash rules (F8), settled once at build time,
// the agent rewrites (F19c), the link rules (§3.4.6) and the mode × kind matrix.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { buildRunHome } from "../../src/index.ts";
import { projectWalk } from "../../src/run-home/items.ts";
import { parseClaudeFrontmatter } from "../../src/run-home/claude-frontmatter.ts";
import type { RunMode } from "../../src/run-home/types.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed, type RunHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);

const skill = (name: string): string => `---\nname: ${name}\ndescription: ${name}\n---\n\nbody of ${name}\n`;
const md = (text: string): string => `---\ndescription: ${text}\n---\n\n${text}\n`;

/** A trusted project at `<root>/repo` with the cwd at `<root>/repo/pkg`. */
function project(bed: RunHomeBed): { root: string; cwd: string; rootDot: string; pkgDot: string } {
  const root = join(bed.root, "repo");
  const cwd = join(root, "pkg");
  mkdirSync(cwd, { recursive: true });
  return { root, cwd, rootDot: join(root, ".winter"), pkgDot: join(cwd, ".winter") };
}

const linkTarget = (path: string): string => readlinkSync(path);

describe("projectWalk (spec §3.4.2)", () => {
  test("cwd up to the trusted root, nearest first", () => {
    expect(projectWalk("/r/a/b", "/r", "/home/u")).toEqual(["/r/a/b", "/r/a", "/r"]);
  });
  test("stops at $HOME, which is never a project directory", () => {
    expect(projectWalk("/home/u/p", "/home", "/home/u")).toEqual(["/home/u/p"]);
    expect(projectWalk("/home/u", "/home/u", "/home/u")).toEqual([]);
  });
  test("no trusted root, no walk; a cwd outside the root walks nothing", () => {
    expect(projectWalk("/r/a", null, "/home/u")).toEqual([]);
    expect(projectWalk("/elsewhere", "/r", "/home/u")).toEqual([]);
  });
});

describe("skills (F8: user beats project, nearest project dir wins; identity is the directory name)", () => {
  test("user, then self, then project nearest-first — the first name wins", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(bed.sdk, "skills", "shared", "SKILL.md"), skill("user-shared"));
    put(join(bed.sdk, "skills", "userself", "SKILL.md"), skill("user-userself"));
    put(join(bed.sdk, "skills", "self", "userself", "SKILL.md"), skill("self-userself"));
    put(join(bed.sdk, "skills", "self", "selfproj", "SKILL.md"), skill("self-selfproj"));
    put(join(p.pkgDot, "skills", "shared", "SKILL.md"), skill("pkg-shared"));
    put(join(p.pkgDot, "skills", "selfproj", "SKILL.md"), skill("pkg-selfproj"));
    put(join(p.pkgDot, "skills", "nearfar", "SKILL.md"), skill("pkg-nearfar"));
    put(join(p.rootDot, "skills", "nearfar", "SKILL.md"), skill("root-nearfar"));
    put(join(p.rootDot, "skills", "rootonly", "SKILL.md"), skill("root-rootonly"));
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const skills = join(runHome.dir, "skills");
    expect(readdirSync(skills).sort()).toEqual(["nearfar", "rootonly", "selfproj", "shared", "userself"]);
    expect(linkTarget(join(skills, "shared"))).toBe(join(bed.sdk, "skills", "shared"));
    expect(linkTarget(join(skills, "userself"))).toBe(join(bed.sdk, "skills", "userself"));
    expect(linkTarget(join(skills, "selfproj"))).toBe(join(bed.sdk, "skills", "self", "selfproj"));
    expect(linkTarget(join(skills, "nearfar"))).toBe(join(p.pkgDot, "skills", "nearfar"));
    expect(linkTarget(join(skills, "rootonly"))).toBe(join(p.rootDot, "skills", "rootonly"));
    // `self` is a TIER, never a skill named "self".
    expect(readdirSync(skills)).not.toContain("self");
    // Every entry is a link to one item directory, and the link resolves.
    for (const name of readdirSync(skills)) expect(lstatSync(join(skills, name)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(skills, "nearfar", "SKILL.md"), "utf8")).toContain("pkg-nearfar");
  });

  test("identity is the directory name, not the frontmatter `name:`", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, "skills", "dir-name", "SKILL.md"), skill("frontmatter-name"));
    const runHome = await buildRunHome(inputFor(bed));
    expect(readdirSync(join(runHome.dir, "skills"))).toEqual(["dir-name"]);
  });
});

describe("commands (F8: user beats project; any skill beats any legacy command)", () => {
  test("user beats project, nearest project dir first, and a command named like a skill is dropped", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(bed.sdk, "commands", "deploy.md"), md("user-deploy"));
    put(join(p.pkgDot, "commands", "deploy.md"), md("pkg-deploy"));
    put(join(p.pkgDot, "commands", "lint.md"), md("pkg-lint"));
    put(join(p.rootDot, "commands", "lint.md"), md("root-lint"));
    put(join(p.rootDot, "commands", "review.md"), md("root-review"));
    put(join(p.rootDot, "skills", "review", "SKILL.md"), skill("review"));
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const commands = join(runHome.dir, "commands");
    expect(readdirSync(commands).sort()).toEqual(["deploy.md", "lint.md"]);
    expect(linkTarget(join(commands, "deploy.md"))).toBe(join(bed.sdk, "commands", "deploy.md"));
    expect(linkTarget(join(commands, "lint.md"))).toBe(join(p.pkgDot, "commands", "lint.md"));
  });
});

describe("output styles (F8: project beats user; the FARTHEST project dir wins)", () => {
  test("the root's style beats the nearer directory's, which beats the user's", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(bed.sdk, "output-styles", "terse.md"), md("user-terse"));
    put(join(bed.sdk, "output-styles", "useronly.md"), md("user-useronly"));
    put(join(p.pkgDot, "output-styles", "terse.md"), md("pkg-terse"));
    put(join(p.rootDot, "output-styles", "terse.md"), md("root-terse"));
    put(join(p.pkgDot, "output-styles", "pkgonly.md"), md("pkg-pkgonly"));
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const styles = join(runHome.dir, "output-styles");
    expect(readdirSync(styles).sort()).toEqual(["pkgonly.md", "terse.md", "useronly.md"]);
    expect(linkTarget(join(styles, "terse.md"))).toBe(join(p.rootDot, "output-styles", "terse.md"));
    expect(linkTarget(join(styles, "useronly.md"))).toBe(join(bed.sdk, "output-styles", "useronly.md"));
  });
});

describe("rules (user files linked; project files COPIED under a path-derived name — R.3 touch)", () => {
  test("user rules keep their relative paths; project rules are `project--<path>.md`", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(bed.sdk, "rules", "style.md"), "user style\n");
    put(join(bed.sdk, "rules", "lang", "ts.md"), "user ts\n");
    put(join(p.rootDot, "rules", "style.md"), "root style\n");
    put(join(p.pkgDot, "rules", "nested", "deep.md"), "pkg deep\n");
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const rules = join(runHome.dir, "rules");
    expect(readFileSync(join(rules, "style.md"), "utf8")).toBe("user style\n");
    expect(readFileSync(join(rules, "lang", "ts.md"), "utf8")).toBe("user ts\n");
    expect(lstatSync(join(rules, "lang")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(rules, "project--.winter--rules--style.md"), "utf8")).toBe("root style\n");
    expect(readFileSync(join(rules, "project--pkg--.winter--rules--nested--deep.md"), "utf8")).toBe("pkg deep\n");
    expect(lstatSync(join(rules, "style.md")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(rules, "project--.winter--rules--style.md")).isSymbolicLink()).toBe(false);
  });
});

describe("agents (copied; permissionMode removed; memory project|local → user; project beats user)", () => {
  test("the copy is rewritten and the project's definition wins", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(bed.sdk, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: user reviewer\npermissionMode: bypassPermissions\n---\n\nuser body\n");
    put(join(bed.sdk, "agents", "helper.md"), "---\nname: helper\ndescription: user helper\nmemory: local\n---\n\nhelper body\n");
    put(
      join(p.rootDot, "agents", "reviewer.md"),
      "---\nname: reviewer\ndescription: project reviewer\nmemory: project\npermissionMode: acceptEdits\ntools:\n  - Read\n  - Grep\n---\n\nproject body\n",
    );
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const agents = join(runHome.dir, "agents");
    expect(readdirSync(agents).sort()).toEqual(["helper.md", "reviewer.md"]);
    for (const name of readdirSync(agents)) {
      expect(lstatSync(join(agents, name)).isSymbolicLink()).toBe(false);
      expect(statSync(join(agents, name)).mode & 0o777).toBe(0o600);
    }
    // Read back the way the runtime reads it (its own split and parse).
    const reviewer = parseClaudeFrontmatter(readFileSync(join(agents, "reviewer.md"), "utf8"))!;
    expect(reviewer.frontmatter).toEqual({ name: "reviewer", description: "project reviewer", memory: "user", tools: ["Read", "Grep"] });
    expect(reviewer.body).toBe("project body\n");
    const helper = parseClaudeFrontmatter(readFileSync(join(agents, "helper.md"), "utf8"))!;
    expect(helper.frontmatter).toEqual({ name: "helper", description: "user helper", memory: "user" });
  });
});

// FIX ROUND 1, I1: the rewrite is made from the RUNTIME'S OWN PARSE, so no YAML spelling of
// `permissionMode` or of a project/local `memory` reaches either runtime. Each variant below reads, by
// the pin's own parse, as `permissionMode` set and/or `memory: project` — the copy must read as neither.
describe("agents: every YAML spelling of permissionMode / memory is caught (I1)", () => {
  const BOM = String.fromCharCode(0xfeff);
  const variants: Array<[string, string]> = [
    ["a quoted key", '---\nname: v\ndescription: d\n"permissionMode": bypassPermissions\n\'memory\': project\n---\nbody\n'],
    ["a duplicate key (YAML keeps the last)", "---\nname: v\ndescription: d\nmemory: user\nmemory: project\n---\nbody\n"],
    ["a flow mapping", "---\n{name: v, description: d, permissionMode: bypassPermissions, memory: project}\n---\nbody\n"],
    ["a `<<:` merge", "---\nbase: &b {permissionMode: bypassPermissions, memory: local}\n<<: *b\nname: v\ndescription: d\n---\nbody\n"],
    ["a leading BOM", `${BOM}---\nname: v\ndescription: d\npermissionMode: bypassPermissions\nmemory: project\n---\nbody\n`],
    ["mixed CRLF", "---\r\nname: v\r\ndescription: d\npermissionMode: bypassPermissions\r\nmemory: project\n---\r\nbody\r\n"],
    ["a `!!str` tag", "---\nname: v\ndescription: d\npermissionMode: !!str bypassPermissions\nmemory: !!str project\n---\nbody\n"],
    ["a `>-` block scalar", "---\nname: v\ndescription: d\npermissionMode: >-\n  bypassPermissions\nmemory: >-\n  project\n---\nbody\n"],
    ["an anchor and alias", "---\nm: &scope project\nname: v\ndescription: d\nmemory: *scope\npermissionMode: &pm bypassPermissions\n---\nbody\n"],
    ["a value on the next line", "---\nname: v\ndescription: d\npermissionMode:\n  bypassPermissions\nmemory:\n  project\n---\nbody\n"],
  ];
  for (const [label, text] of variants) {
    test(label, async () => {
      // The variant IS a bypass of a line editor: the runtime's own parse sees the keys.
      const before = parseClaudeFrontmatter(text)!;
      expect(before.frontmatter["permissionMode"] !== undefined || before.frontmatter["memory"] === "project" || before.frontmatter["memory"] === "local").toBe(true);
      const bed = runHomeBed();
      const p = project(bed);
      put(join(p.rootDot, "agents", "v.md"), text);
      const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
      const copied = join(runHome.dir, "agents", "v.md");
      expect(existsSync(copied)).toBe(true);
      const after = parseClaudeFrontmatter(readFileSync(copied, "utf8"))!;
      expect(after.error).toBeUndefined();
      expect("permissionMode" in after.frontmatter).toBe(false);
      expect(after.frontmatter["memory"] === undefined || after.frontmatter["memory"] === "user").toBe(true);
      expect(after.frontmatter["name"]).toBe("v");
      expect(runHome.report.skippedAgents).toEqual([]);
    });
  }

  test("a frontmatter the runtime cannot parse is skipped and reported, never copied", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.rootDot, "agents", "broken.md"), "---\nname: broken\n  bad: [unclosed\n\t- x: {\n---\nbody\n");
    expect(parseClaudeFrontmatter(readFileSync(join(p.rootDot, "agents", "broken.md"), "utf8"))!.error).toBeDefined();
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(readdirSync(join(runHome.dir, "agents"))).toEqual([]);
    expect(runHome.report.skippedAgents).toEqual([{ path: join(p.rootDot, "agents", "broken.md"), reason: "unparseable" }]);
  });

  test("identity comes from the same parse: a quoted `name` key names the agent", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, "agents", "file-stem.md"), '---\n"name": parsed-name\ndescription: d\n---\nbody\n');
    const runHome = await buildRunHome(inputFor(bed));
    expect(readdirSync(join(runHome.dir, "agents"))).toEqual(["parsed-name.md"]);
  });

  test("a file with no frontmatter block is copied as-is (the runtime reads no keys from it)", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, "agents", "plain.md"), "permissionMode: bypassPermissions\nno frontmatter here\n");
    const runHome = await buildRunHome(inputFor(bed));
    expect(readFileSync(join(runHome.dir, "agents", "plain.md"), "utf8")).toBe("permissionMode: bypassPermissions\nno frontmatter here\n");
  });
});

describe("link targets (spec §3.4.6)", () => {
  test("a user item linked outside sdk/ is linked as-is and reported", async () => {
    const bed = runHomeBed();
    const outside = join(bed.root, "outside-skill");
    put(join(outside, "SKILL.md"), skill("outside"));
    mkdirSync(join(bed.sdk, "skills"), { recursive: true });
    symlinkSync(outside, join(bed.sdk, "skills", "ext"));
    const runHome = await buildRunHome(inputFor(bed));
    expect(linkTarget(join(runHome.dir, "skills", "ext"))).toBe(join(bed.sdk, "skills", "ext"));
    expect(runHome.report.externalUserLinks).toEqual([join(bed.sdk, "skills", "ext")]);
  });

  test("a project item that points outside the project root is skipped and reported", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    const outside = join(bed.root, "evil-skill");
    put(join(outside, "SKILL.md"), skill("evil"));
    mkdirSync(join(p.rootDot, "skills"), { recursive: true });
    symlinkSync(outside, join(p.rootDot, "skills", "evil"));
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(existsSync(join(runHome.dir, "skills", "evil"))).toBe(false);
    expect(runHome.report.skippedLinks).toEqual([{ path: join(p.rootDot, "skills", "evil"), reason: "outside-root" }]);
  });

  test("a project dot-dir that is itself a link out of the root contributes nothing", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    const outside = join(bed.root, "evil-dot");
    put(join(outside, "skills", "x", "SKILL.md"), skill("x"));
    put(join(outside, "agents", "a.md"), "---\nname: a\n---\n");
    symlinkSync(outside, p.rootDot);
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(existsSync(join(runHome.dir, "skills", "x"))).toBe(false);
    expect(existsSync(join(runHome.dir, "agents", "a.md"))).toBe(false);
    expect(runHome.report.skippedLinks.map((entry) => entry.reason)).toContain("outside-root");
  });

  test("a project item inside the root is linked by its REAL path (a later re-point of the link changes nothing)", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.root, "shared-skills", "inner", "SKILL.md"), skill("inner"));
    mkdirSync(join(p.rootDot, "skills"), { recursive: true });
    symlinkSync(join(p.root, "shared-skills", "inner"), join(p.rootDot, "skills", "inner"));
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(linkTarget(join(runHome.dir, "skills", "inner"))).toBe(realpathSync(join(p.root, "shared-skills", "inner")));
  });

  test("a dangling project link is skipped and reported `missing`", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    mkdirSync(join(p.rootDot, "skills"), { recursive: true });
    symlinkSync(join(p.root, "gone"), join(p.rootDot, "skills", "gone"));
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(runHome.report.skippedLinks).toEqual([{ path: join(p.rootDot, "skills", "gone"), reason: "missing" }]);
  });

  test("an untrusted project contributes nothing at all", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.rootDot, "skills", "x", "SKILL.md"), skill("x"));
    put(join(p.rootDot, "agents", "a.md"), "---\nname: a\n---\n");
    put(join(p.rootDot, "rules", "r.md"), "r\n");
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: null, gitRoot: p.root }));
    for (const kind of ["skills", "agents", "rules", "commands", "output-styles"]) {
      const dir = join(runHome.dir, kind);
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }
  });
});

describe("the mode × kind matrix (spec §3.2)", () => {
  const plantEverything = (bed: RunHomeBed): ReturnType<typeof project> => {
    const p = project(bed);
    put(join(bed.sdk, "skills", "us", "SKILL.md"), skill("us"));
    put(join(bed.sdk, "commands", "uc.md"), md("uc"));
    put(join(bed.sdk, "output-styles", "uo.md"), md("uo"));
    put(join(bed.sdk, "rules", "ur.md"), "ur\n");
    put(join(bed.sdk, "agents", "ua.md"), "---\nname: ua\n---\n");
    put(join(p.rootDot, "skills", "ps", "SKILL.md"), skill("ps"));
    put(join(p.rootDot, "commands", "pc.md"), md("pc"));
    put(join(p.rootDot, "output-styles", "po.md"), md("po"));
    put(join(p.rootDot, "rules", "pr.md"), "pr\n");
    put(join(p.rootDot, "agents", "pa.md"), "---\nname: pa\n---\n");
    return p;
  };
  const names = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

  const cases: Array<{ mode: RunMode; dispatchChild: boolean; expected: Record<string, string[]> }> = [
    {
      mode: "code",
      dispatchChild: false,
      expected: { skills: ["ps", "us"], commands: ["pc.md", "uc.md"], "output-styles": ["po.md", "uo.md"], rules: ["project--.winter--rules--pr.md", "ur.md"], agents: ["pa.md", "ua.md"] },
    },
    {
      mode: "code",
      dispatchChild: true,
      expected: { skills: ["ps", "us"], commands: ["pc.md", "uc.md"], "output-styles": [], rules: ["project--.winter--rules--pr.md", "ur.md"], agents: ["pa.md", "ua.md"] },
    },
    { mode: "dispatch", dispatchChild: false, expected: { skills: [], commands: [], "output-styles": [], rules: ["project--.winter--rules--pr.md"], agents: ["pa.md", "ua.md"] } },
    { mode: "chat", dispatchChild: false, expected: { skills: [], commands: [], "output-styles": [], rules: ["project--.winter--rules--pr.md"], agents: ["pa.md", "ua.md"] } },
  ];
  for (const { mode, dispatchChild, expected } of cases) {
    test(`${mode}${dispatchChild ? " (dispatch child)" : ""}`, async () => {
      const bed = runHomeBed();
      const p = plantEverything(bed);
      const runHome = await buildRunHome(inputFor(bed, { mode, dispatchChild, cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
      for (const [kind, want] of Object.entries(expected)) expect([kind, names(join(runHome.dir, kind))]).toEqual([kind, want]);
    });
  }
});
