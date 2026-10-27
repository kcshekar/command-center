// N14 — dependency inventory + vulnerability classification. Pure (no I/O):
// lockfile parsing, version comparison, and deciding whether a fix is a
// minor/patch bump (auto PR, once GitHub is connected) or a major one (ask
// first, with impact). The activity does the reading, OSV calls and posting.

export interface Dep { name: string; version: string }

const isRealVersion = (v: string) => /^\d+\.\d+\.\d+/.test(v);

function splitSpec(spec: string): Dep | null {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return null;
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  return isRealVersion(version) ? { name, version } : null; // skips workspace:/link:/git deps
}

/** bun.lock (text, JSONC-ish): `"name": ["name@version", …]` lines under "packages". */
export function parseBunLock(text: string): Dep[] {
  const start = text.indexOf('"packages": {');
  if (start < 0) return [];
  const out: Dep[] = [];
  for (const m of text.slice(start).matchAll(/^\s*"[^"]+": \["([^"]+)"/gm)) {
    const d = splitSpec(m[1]);
    if (d) out.push(d);
  }
  return dedupe(out);
}

/** pnpm-lock.yaml v9: two-space keys `'name@version':` / `name@version:` under `packages:`. */
export function parsePnpmLock(text: string): Dep[] {
  const lines = text.split("\n");
  const out: Dep[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inPackages = line.startsWith("packages:"); // top-level section switch
    if (!inPackages) continue;
    const m = line.match(/^ {2}'?([^'\s][^']*?)'?:\s*$/);
    if (!m) continue;
    const d = splitSpec(m[1].replace(/\(.*$/, "")); // drop peer suffixes "(react@19…)"
    if (d) out.push(d);
  }
  return dedupe(out);
}

function dedupe(deps: Dep[]): Dep[] {
  const seen = new Set<string>();
  return deps.filter((d) => {
    const k = `${d.name}@${d.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Compare x.y.z (pre-release suffix sorts before the release). */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface OsvRange { type: string; events: Array<{ introduced?: string; fixed?: string; last_affected?: string }> }

/** Smallest version that fixes `current`, from OSV affected ranges; null if none published. */
export function fixedVersionFor(current: string, ranges: OsvRange[]): string | null {
  const fixes: string[] = [];
  for (const r of ranges.filter((r) => r.type === "SEMVER" || r.type === "ECOSYSTEM")) {
    let introduced = "0";
    for (const e of r.events) {
      if (e.introduced !== undefined) introduced = e.introduced;
      if (e.fixed !== undefined) {
        const affected = (introduced === "0" || cmpVersion(current, introduced) >= 0) && cmpVersion(current, e.fixed) < 0;
        if (affected) fixes.push(e.fixed);
      }
    }
  }
  return fixes.sort(cmpVersion)[0] ?? null;
}

export type FixKind = "minor" | "major" | "none";

/** Same major version → minor/patch fix (auto PR); different major → ask first. */
export function classifyFix(current: string, fixed: string | null): FixKind {
  if (!fixed) return "none";
  return current.split(".")[0] === fixed.split(".")[0] ? "minor" : "major";
}

export interface Finding {
  name: string;
  version: string;
  fixed: string | null;
  kind: FixKind;
  severity: string;   // CRITICAL | HIGH | MODERATE | LOW | UNKNOWN
  advisory: string;   // GHSA-… / CVE-…
  summary: string;
  lockfiles: string[];
}

const SEV_ORDER = ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"];

/** One package version with every advisory against it — the unit you actually upgrade. */
export interface PackageFinding {
  name: string;
  version: string;
  fixTo: string | null;     // fixes every advisory with a published fix
  unfixed: number;          // advisories with no fix yet
  kind: FixKind;            // major if any advisory needs a new major
  severity: string;         // worst across advisories
  advisories: string[];
  summary: string;          // of the worst advisory
  lockfiles: string[];
}

export function groupByPackage(findings: Finding[]): PackageFinding[] {
  const by = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = `${f.name}@${f.version}`;
    by.set(k, [...(by.get(k) ?? []), f]);
  }
  return [...by.values()].map((fs) => {
    const worst = [...fs].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))[0];
    const fixes = fs.map((f) => f.fixed).filter((v): v is string => !!v).sort(cmpVersion);
    const fixTo = fixes[fixes.length - 1] ?? null;
    return {
      name: worst.name,
      version: worst.version,
      fixTo,
      unfixed: fs.filter((f) => !f.fixed).length,
      kind: classifyFix(worst.version, fixTo),
      severity: worst.severity,
      advisories: [...new Set(fs.map((f) => f.advisory))],
      summary: worst.summary,
      lockfiles: [...new Set(fs.flatMap((f) => f.lockfiles))],
    };
  });
}

export function formatScan(findings: Finding[], packages: number, githubReady: boolean): string {
  if (findings.length === 0) return `🛡️ Security scan: no known vulnerabilities across ${packages} packages.`;
  const grouped = groupByPackage(findings).sort(
    (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || a.name.localeCompare(b.name),
  );
  const line = (p: PackageFinding) => {
    const adv = p.advisories.length === 1
      ? `<https://osv.dev/vulnerability/${p.advisories[0]}|${p.advisories[0]}>`
      : `${p.advisories.length} advisories`;
    const target = p.fixTo ? ` → ${p.fixTo}` : "";
    const open = p.unfixed && p.fixTo ? ` (${p.unfixed} still unfixed)` : "";
    return `• *${p.name}* ${p.version}${target}${open} · ${p.severity} · ${adv} — ${p.summary.slice(0, 80)} _(${p.lockfiles.join(", ")})_`;
  };
  const of = (kind: FixKind) => grouped.filter((p) => p.kind === kind);
  const minor = of("minor"), major = of("major"), none = of("none");
  const lines = [`🛡️ *Security scan: ${grouped.length} vulnerable package${grouped.length === 1 ? "" : "s"}* (${findings.length} advisories, ${packages} packages checked)`];
  if (major.length) lines.push("", "*Major upgrades needed — nothing changes without your approval*", ...major.map(line));
  if (minor.length) lines.push("", githubReady ? "*Minor/patch fixes — a pull request is opened for these*" : "*Minor/patch fixes — will be opened as a pull request once GitHub is connected*", ...minor.map(line));
  if (none.length) lines.push("", "*No fix published yet — watching*", ...none.map(line));
  return lines.join("\n");
}
