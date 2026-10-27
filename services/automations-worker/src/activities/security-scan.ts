import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "../db.js";
import { cc } from "../cc-client.js";
import { classifyFix, fixedVersionFor, formatScan, parseBunLock, parsePnpmLock, type Dep, type Finding, type OsvRange } from "../deps-scan.js";

// N14 — weekly dependency security scan (system schedule; decision 2026-10-27).
//   1. Inventory: re-parse a lockfile only when its sha256 changed.
//   2. Ask OSV.dev (free, no key) about every stored name@version.
//   3. Classify each finding: minor/patch fix · major upgrade · no fix yet.
// Applying fixes (a pull request per minor fix; majors only after approval)
// is step 2 of N14 and needs the GitHub sign-in configured — not built yet.

const REPO_ROOT = process.env.PLATFORM_REPO_ROOT ?? resolve(new URL("../../../../", import.meta.url).pathname);
const LOCKFILES: Array<{ path: string; parse: (t: string) => Dep[] }> = [
  { path: "bun.lock", parse: parseBunLock },
  { path: "apps/api/pnpm-lock.yaml", parse: parsePnpmLock },
  { path: "services/automations-worker/pnpm-lock.yaml", parse: parsePnpmLock },
];
const OSV = "https://api.osv.dev/v1";
const BATCH = 500;

async function refreshInventory(): Promise<{ changed: string[] }> {
  const changed: string[] = [];
  for (const lf of LOCKFILES) {
    let text: string;
    try { text = await readFile(resolve(REPO_ROOT, lf.path), "utf8"); }
    catch { continue; } // lockfile not present on this machine
    const sha = createHash("sha256").update(text).digest("hex");
    const { rows } = await pool.query("SELECT sha256 FROM dep_lockfiles WHERE path = $1", [lf.path]);
    if (rows[0]?.sha256 === sha) continue;
    const deps = lf.parse(text);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO dep_lockfiles (path, sha256, packages, indexed_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (path) DO UPDATE SET sha256 = EXCLUDED.sha256, packages = EXCLUDED.packages, indexed_at = now()`,
        [lf.path, sha, deps.length],
      );
      await client.query("DELETE FROM dep_inventory WHERE lockfile = $1", [lf.path]);
      if (deps.length) {
        await client.query(
          `INSERT INTO dep_inventory (lockfile, name, version)
           SELECT $1, unnest($2::text[]), unnest($3::text[]) ON CONFLICT DO NOTHING`,
          [lf.path, deps.map((d) => d.name), deps.map((d) => d.version)],
        );
      }
      await client.query("COMMIT");
      changed.push(lf.path);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return { changed };
}

async function osv<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${OSV}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`osv ${res.status} ${path}`);
  return (await res.json()) as T;
}

/** Inventory refresh + OSV lookup; no posting (used by the activity and for dry runs). */
export async function collectFindings(): Promise<{ findings: Finding[]; packages: number; reindexed: string[] }> {
  const { changed } = await refreshInventory();
  const { rows } = await pool.query<{ name: string; version: string; lockfiles: string[] }>(
    "SELECT name, version, array_agg(lockfile ORDER BY lockfile) AS lockfiles FROM dep_inventory GROUP BY name, version",
  );

  const hits: Array<{ dep: (typeof rows)[number]; ids: string[] }> = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await osv<{ results: Array<{ vulns?: Array<{ id: string }> }> }>("/querybatch", {
      queries: chunk.map((d) => ({ package: { name: d.name, ecosystem: "npm" }, version: d.version })),
    });
    res.results.forEach((r, j) => { if (r.vulns?.length) hits.push({ dep: chunk[j], ids: r.vulns.map((v) => v.id) }); });
  }

  const details = new Map<string, { summary?: string; database_specific?: { severity?: string }; affected?: Array<{ package?: { name?: string; ecosystem?: string }; ranges?: OsvRange[] }> }>();
  const findings: Finding[] = [];
  for (const { dep, ids } of hits) {
    for (const id of ids) {
      if (!details.has(id)) details.set(id, await osv(`/vulns/${encodeURIComponent(id)}`));
      const v = details.get(id)!;
      const ranges = (v.affected ?? []).filter((a) => a.package?.ecosystem === "npm" && a.package?.name === dep.name).flatMap((a) => a.ranges ?? []);
      const fixed = fixedVersionFor(dep.version, ranges);
      findings.push({
        name: dep.name, version: dep.version, fixed, kind: classifyFix(dep.version, fixed),
        severity: (v.database_specific?.severity ?? "UNKNOWN").toUpperCase(),
        advisory: id, summary: v.summary ?? "", lockfiles: dep.lockfiles.map((p) => p.split("/").slice(0, -1).join("/") || "root"),
      });
    }
  }

  return { findings, packages: rows.length, reindexed: changed };
}

export async function scanDependencyVulns(input: { routeKey?: string } = {}): Promise<{ packages: number; findings: number; reindexed: string[] }> {
  const { findings, packages, reindexed } = await collectFindings();
  const githubReady = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  await cc.notify(input.routeKey ?? process.env.PLATFORM_UPGRADE_ROUTE_KEY ?? "automations.digest", formatScan(findings, packages, githubReady));
  return { packages, findings: findings.length, reindexed };
}
