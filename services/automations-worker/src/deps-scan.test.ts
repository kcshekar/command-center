import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFix, cmpVersion, fixedVersionFor, formatScan, parseBunLock, parsePnpmLock } from "./deps-scan.js";

test("lockfile parsers: real versions only, scoped names, peer suffixes, sections", () => {
  const bun = `{
  "workspaces": { "apps/api": { "dependencies": { "zod": "^3.0.0", }, }, },
  "packages": {
    "@alloc/quick-lru": ["@alloc/quick-lru@5.2.0", "", {}, "sha512-x"],

    "@command-center/api": ["@command-center/api@workspace:apps/api"],
    "next": ["next@16.3.2", "", { "dependencies": {} }, "sha512-y"],
  }
}`;
  assert.deepEqual(parseBunLock(bun), [{ name: "@alloc/quick-lru", version: "5.2.0" }, { name: "next", version: "16.3.2" }]);

  const pnpm = `lockfileVersion: '9.0'

importers:
  .:
    dependencies:
      pg:
        specifier: ^8.11.0

packages:

  '@esbuild/aix-ppc64@0.28.2':
    resolution: {integrity: sha512-x}

  pg@8.13.1:
    resolution: {integrity: sha512-y}

  ws@8.18.0(bufferutil@4.0.8):
    resolution: {integrity: sha512-z}

snapshots:

  pg@8.13.1:
    dependencies: {}
`;
  assert.deepEqual(parsePnpmLock(pnpm), [
    { name: "@esbuild/aix-ppc64", version: "0.28.2" },
    { name: "pg", version: "8.13.1" },
    { name: "ws", version: "8.18.0" },
  ]);
});

test("versions: compare, pick the smallest applicable fix, classify", () => {
  assert.ok(cmpVersion("1.10.0", "1.9.9") > 0);
  assert.ok(cmpVersion("2.0.0-rc.1", "2.0.0") < 0);
  const ranges = [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }, { introduced: "5.0.0" }, { fixed: "5.0.3" }] }];
  assert.equal(fixedVersionFor("4.17.15", ranges), "4.17.21");
  assert.equal(fixedVersionFor("5.0.1", ranges), "5.0.3");
  assert.equal(fixedVersionFor("4.17.21", ranges), null); // already fixed
  assert.equal(fixedVersionFor("1.0.0", [{ type: "SEMVER", events: [{ introduced: "0" }] }]), null); // no fix yet
  assert.equal(classifyFix("4.17.15", "4.17.21"), "minor");
  assert.equal(classifyFix("1.4.0", "2.0.1"), "major");
  assert.equal(classifyFix("1.4.0", null), "none");
});

test("report: one line per package version, worst severity, fix-all target, majors first", () => {
  const f = (name: string, version: string, fixed: string | null, severity: string, id: string) =>
    ({ name, version, fixed, kind: classifyFix(version, fixed), severity, advisory: id, summary: `${name} issue ${id}`, lockfiles: ["root"] });
  const text = formatScan([
    f("undici", "7.29.0", "7.29.1", "MODERATE", "A1"),
    f("undici", "7.29.0", "7.30.1", "MODERATE", "A2"),
    f("undici", "7.29.0", "7.29.1", "LOW", "A3"),
    f("nodemailer", "9.0.5", "9.1.0", "MODERATE", "N1"),   // one advisory is a minor fix…
    f("nodemailer", "9.0.5", "10.0.6", "HIGH", "N2"),      // …but another needs v10 → major overall
    f("left-pad", "1.0.0", null, "LOW", "L1"),
  ], 989, false);
  assert.match(text, /3 vulnerable packages\* \(6 advisories, 989 packages checked\)/);
  assert.match(text, /without your approval\*\n• \*nodemailer\* 9\.0\.5 → 10\.0\.6 · HIGH · 2 advisories — nodemailer issue N2/);
  assert.match(text, /GitHub is connected\*\n• \*undici\* 7\.29\.0 → 7\.30\.1 · MODERATE · 3 advisories/);
  assert.match(text, /watching\*\n• \*left-pad\* 1\.0\.0 · LOW · <https:\/\/osv\.dev\/vulnerability\/L1\|L1>/);
  assert.ok(text.indexOf("Major upgrades") < text.indexOf("Minor/patch"));
  assert.equal(formatScan([], 812, false), "🛡️ Security scan: no known vulnerabilities across 812 packages.");
});
