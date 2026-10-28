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
    // 404 and other permanent errors: skip this repo, don't fail the sweep.
    if (res.status === 429 || res.status >= 500) throw new Error(`github ${res.status}`); // retryable → caller dead-letters it
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

// dev.to API is anonymous. `top=7` gives last 7 days of top posts; filter by
// sinceIso to drop anything older than our window.
export async function fetchDevToTagArticles(tag: string, sinceIso: string, perTag = 10): Promise<LearningCandidate[]> {
  const url = `https://dev.to/api/articles?tag=${encodeURIComponent(tag)}&top=7&per_page=${perTag}`;
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) throw new Error(`devto ${res.status}`); // retryable → caller dead-letters it
    console.warn(`[a8.learning] dev.to ${tag} → ${res.status}`);
    return [];
  }
  const body = (await res.json()) as Array<{
    id: number; title?: string; url?: string; description?: string;
    published_at?: string; user?: { name?: string }; tags?: string;
    positive_reactions_count?: number;
  }>;
  const sinceMs = new Date(sinceIso).getTime();
  const out: LearningCandidate[] = [];
  for (const a of body) {
    if (!a.id || !a.title || !a.url) continue;
    const pub = a.published_at;
    if (!pub || new Date(pub).getTime() < sinceMs) continue;
    out.push({
      source: "a8.learning",
      sourceId: `devto:${a.id}`,
      title: a.title,
      url: a.url,
      publishedAt: pub,
      kind: "dev_to_tag",
      target: tag,
      summary: a.description ? a.description.slice(0, 500) : undefined,
      meta: { author: a.user?.name, reactions: a.positive_reactions_count, tags: a.tags },
    });
  }
  return out;
}

// Minimal RSS/Atom parser — regex-extract <item>/<entry> blocks and pull
// title/link/pubDate/description. Not a full spec implementation, but good
// enough for the vast majority of blog feeds.
// ponytail: hand-rolled regex, swap for rss-parser if we hit a feed it chokes on.
export async function fetchRssFeed(feedUrl: string, sinceIso: string, perFeed = 10): Promise<LearningCandidate[]> {
  const res = await fetch(feedUrl, { headers: { "Accept": "application/rss+xml, application/atom+xml, */*" } });
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) throw new Error(`rss ${res.status}`); // retryable → caller dead-letters it
    console.warn(`[a8.learning] rss ${feedUrl} → ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const items = extractRssItems(xml, perFeed);
  const sinceMs = new Date(sinceIso).getTime();
  const out: LearningCandidate[] = [];
  for (const it of items) {
    if (!it.link || !it.title) continue;
    const pubMs = it.pubDate ? new Date(it.pubDate).getTime() : NaN;
    if (!Number.isNaN(pubMs) && pubMs < sinceMs) continue;
    out.push({
      source: "a8.learning",
      sourceId: `rss:${hashString(feedUrl)}:${hashString(it.link)}`,
      title: it.title,
      url: it.link,
      publishedAt: it.pubDate ?? new Date().toISOString(),
      kind: "rss",
      target: feedUrl,
      summary: it.description ? stripTags(it.description).slice(0, 500) : undefined,
      meta: { feed: feedUrl },
    });
  }
  return out;
}

function extractRssItems(xml: string, max: number): Array<{ title: string | null; link: string | null; pubDate: string | null; description: string | null }> {
  const blocks: Array<{ title: string | null; link: string | null; pubDate: string | null; description: string | null }> = [];
  // RSS <item> or Atom <entry>.
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && blocks.length < max) {
    const body = m[2];
    const title = pickXml(body, "title");
    // Atom uses <link href="…"/> or <link>…</link>; RSS uses <link>…</link>.
    const link = pickXml(body, "link") ?? pickAttr(body, "link", "href");
    const pubDate = pickXml(body, "pubDate") ?? pickXml(body, "published") ?? pickXml(body, "updated");
    const description = pickXml(body, "description") ?? pickXml(body, "summary") ?? pickXml(body, "content");
    blocks.push({ title, link, pubDate, description });
  }
  return blocks;
}
function pickXml(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return null;
  return unxml(m[1].trim());
}
function pickAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']+)["']`, "i");
  const m = xml.match(re);
  return m ? m[1] : null;
}
function unxml(s: string): string {
  // Strip CDATA wrapper + decode basic entities.
  s = s.replace(/^<!\[CDATA\[|\]\]>$/g, "");
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function hashString(s: string): string {
  // Tiny, stable, non-crypto — just needs to be short + unique enough per feed.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
