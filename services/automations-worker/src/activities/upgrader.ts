import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cc } from "../cc-client.js";
import { retrieveKnowledgeContext } from "./knowledge-rag.js";

// A11 — monthly dep upgrade scan.
//
// Reads every package.json under PLATFORM_REPO_ROOT (default: the monorepo
// root resolved from the worker's cwd), collects declared deps, asks the npm
// registry for the latest version of each, and Slacks a review-only
// summary. We do NOT change package.json or run installs — the catalog is
// explicit about "review-only".
//
// Only runs filesystem reads inside the configured root; no shell-outs, no
// npm/pnpm invocations, no network beyond registry.npmjs.org.

const PLATFORM_UPGRADE_ROUTE = process.env.PLATFORM_UPGRADE_ROUTE_KEY ?? "automations.digest";
const PLATFORM_REPO_ROOT = process.env.PLATFORM_REPO_ROOT
  ?? resolve(new URL("../../../../", import.meta.url).pathname);

type Bump = "major" | "minor" | "patch" | "unchanged" | "unknown";

export interface DepUpgrade {
  pkg: string;
  current: string;      // raw spec from package.json (e.g. "^18.3.1")
  currentPinned: string | null;  // parsed numeric or null (git/file/etc)
  latest: string | null;
  bump: Bump;
  packageJsonPath: string;
  scope: "dependencies" | "devDependencies" | "peerDependencies";
}

// Strip npm range operators (^, ~, =, >=, pre-releases etc) down to x.y.z.
function toPinned(spec: string): string | null {
  if (!spec) return null;
  // Skip anything that isn't a plain semver (git URLs, file paths, workspace:*)
  if (/^(git\+|git:|file:|workspace:|npm:|link:)/.test(spec)) return null;
  const m = spec.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function classifyBump(current: string | null, latest: string | null): Bump {
  if (!current || !latest) return "unknown";
  const cp = current.split(".").map(Number);
  const lp = latest.split(".").map(Number);
  if (cp.length < 3 || lp.length < 3 || cp.some(isNaN) || lp.some(isNaN)) return "unknown";
  if (cp[0] !== lp[0]) return lp[0] > cp[0] ? "major" : "unchanged";
  if (cp[1] !== lp[1]) return lp[1] > cp[1] ? "minor" : "unchanged";
  if (cp[2] !== lp[2]) return lp[2] > cp[2] ? "patch" : "unchanged";
  return "unchanged";
}

async function findPackageJsons(root: string, acc: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 6) return acc; // defence against runaway recursion
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".next") continue;
    const full = join(root, e.name);
    if (e.isDirectory()) await findPackageJsons(full, acc, depth + 1);
    else if (e.isFile() && e.name === "package.json") acc.push(full);
  }
  return acc;
}

async function fetchLatest(pkg: string): Promise<string | null> {
  // Registry docs: /:pkg returns full packument; /:pkg/latest is cheaper and
  // enough for us. 404 → unlisted package (private, scoped-not-published, …).
  const url = `https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const body = (await res.json()) as { version?: string };
  return body.version ?? null;
}

export async function scanRepoDepUpgrades(input: {
  routeKey?: string;
  rootDir?: string;
  userId?: string;   // P1.4: whose /brain lessons to check (system schedule: PLATFORM_OWNER_USER_ID)
} = {}): Promise<{
  packageJsons: number;
  depsExamined: number;
  upgrades: number;
  major: number;
  minor: number;
  patch: number;
  posted: boolean;
}> {
  const root = input.rootDir ?? PLATFORM_REPO_ROOT;
  const pkgFiles = await findPackageJsons(root);

  // Dedupe deps across workspaces: last-wins on name so we only query the
  // registry once per package even if 3 workspaces declare it.
  const unique = new Map<string, DepUpgrade>();

  for (const file of pkgFiles) {
    const text = await readFile(file, "utf8").catch(() => null);
    if (!text) continue;
    let json: any;
    try { json = JSON.parse(text); } catch { continue; }
    for (const scope of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const deps = json[scope] ?? {};
      for (const [pkg, specRaw] of Object.entries(deps)) {
        if (typeof specRaw !== "string") continue;
        const pinned = toPinned(specRaw);
        if (!unique.has(pkg)) {
          unique.set(pkg, {
            pkg, current: specRaw, currentPinned: pinned,
            latest: null, bump: "unknown",
            packageJsonPath: file.replace(root + "/", ""),
            scope,
          });
        }
      }
    }
  }

  // Sequential registry calls to stay polite + avoid upstream rate-limiting
  // on a long dep list. ~5 req/s is fine.
  for (const [, dep] of unique) {
    try {
      const latest = await fetchLatest(dep.pkg);
      dep.latest = latest;
      dep.bump = classifyBump(dep.currentPinned, latest);
    } catch { /* leave as unknown */ }
  }

  const all = [...unique.values()];
  const upgrades = all.filter((d) => d.bump === "major" || d.bump === "minor" || d.bump === "patch");
  upgrades.sort((a, b) => {
    const order = { major: 0, minor: 1, patch: 2, unknown: 3, unchanged: 4 } as const;
    return order[a.bump] - order[b.bump] || a.pkg.localeCompare(b.pkg);
  });
  const major = upgrades.filter((d) => d.bump === "major").length;
  const minor = upgrades.filter((d) => d.bump === "minor").length;
  const patch = upgrades.filter((d) => d.bump === "patch").length;

  // Slack summary — compact, top 15.
  const dayTag = new Date().toISOString().slice(0, 10);
  const top = upgrades.slice(0, 15);

  // P1.4 — a lesson the user saved about a package ("zod 4 broke shadcn forms")
  // gets quoted next to that upgrade, so the scan doesn't re-propose it blind.
  // Only lessons the user wrote: A8's auto-ingested release notes mention
  // half the ecosystem and would flag everything.
  const lessons = input.userId
    ? await retrieveKnowledgeContext({ userId: input.userId, query: top.map((d) => d.pkg).join(" "), types: ["lesson", "note"], limit: 10 })
    : [];
  const lessonFor = (pkg: string) => lessons.find((l) => l.source === "user" && `${l.title} ${l.body ?? ""}`.toLowerCase().includes(pkg.toLowerCase()));
  const header = `🧰 *A11 Upgrade scan — ${dayTag}*\n\n` +
    `Scanned ${pkgFiles.length} package.json file(s), ${all.length} unique deps.\n` +
    `Upgrades available: ${upgrades.length} (major ${major} · minor ${minor} · patch ${patch})`;
  const body = top.length === 0
    ? "\n\nEverything is on latest. Nothing to review."
    : "\n\n*Top " + top.length + ":*\n" + top.map((d) => {
        const lesson = lessonFor(d.pkg);
        return `• [${d.bump.padEnd(5)}] *${d.pkg}* ${d.currentPinned ?? d.current} → ${d.latest} _(${d.scope} in ${d.packageJsonPath})_` +
          (lesson ? `\n    ⚠ your note: ${lesson.title}` : "");
      }).join("\n");
  const footer = upgrades.length > top.length
    ? `\n\n_+${upgrades.length - top.length} more upgrades hidden._`
    : "";
  const text = header + body + footer;

  let posted = false;
  try {
    await cc.notify(input.routeKey ?? PLATFORM_UPGRADE_ROUTE, text);
    posted = true;
  } catch (err) {
    console.warn("[a11.upgrader] slack notify failed", { err: String(err) });
  }

  return {
    packageJsons: pkgFiles.length,
    depsExamined: all.length,
    upgrades: upgrades.length,
    major, minor, patch,
    posted,
  };
}
