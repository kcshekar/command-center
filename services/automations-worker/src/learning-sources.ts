// A8 — learning source adapters. One function per source_kind in
// learning_goals, each returning a uniform LearningCandidate.
//
// Starting with GitHub Releases via the anonymous API (/repos/:owner/:repo/
// releases). dev.to tag + arbitrary RSS come next.
// ponytail: anonymous API, auth later if we start hitting rate limits.

export interface LearningCandidate {
  source: string;        // 'a8.learning'
  sourceId: string;      // 'gh:owner/repo:tag' | 'devto:article-id' | ...
  title: string;
  url: string;
  publishedAt: string;   // ISO
  kind: string;          // the source_kind from the goal
  target: string;        // the goal's target (repo name, tag, feed url)
  summary?: string;      // short excerpt / release notes
  meta?: Record<string, unknown>;
}

const GH = "https://api.github.com";

export async function fetchGithubReleases(repo: string, sinceIso: string, perRepo = 5): Promise<LearningCandidate[]> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return [];
  const res = await fetch(`${GH}/repos/${owner}/${name}/releases?per_page=${perRepo}`, {
    headers: { "Accept": "application/vnd.github+json", "User-Agent": "memoryAllocator-a8" },
  });
  if (!res.ok) {
    // 404 / rate-limit / network — skip this repo, don't fail the sweep.
    console.warn(`[a8.learning] github releases ${repo} → ${res.status}`);
    return [];
  }
  const body = (await res.json()) as Array<{
    name?: string; tag_name?: string; html_url?: string;
    published_at?: string; prerelease?: boolean; draft?: boolean;
    body?: string;
  }>;
  const sinceMs = new Date(sinceIso).getTime();
  const out: LearningCandidate[] = [];
  for (const r of body) {
    if (r.draft || r.prerelease) continue;
    if (!r.tag_name || !r.html_url) continue;
    const published = r.published_at;
    if (!published || new Date(published).getTime() < sinceMs) continue;
    out.push({
      source: "a8.learning",
      sourceId: `gh:${repo}:${r.tag_name}`,
      title: `${repo} — ${r.name && r.name.trim() ? r.name : r.tag_name}`,
      url: r.html_url,
      publishedAt: published,
      kind: "github_release",
      target: repo,
      summary: r.body ? r.body.slice(0, 500) : undefined,
      meta: { tag: r.tag_name, owner, repo: name },
    });
  }
  return out;
}
