// A1 — news source adapters. One function per source; each returns a
// uniform NewsCandidate so classifier/drafter stay source-agnostic.
//
// Starting with Hacker News since the firebase API is anonymous (no key)
// and the signal/noise ratio is good for a tech brief.
// ponytail: HN only, add TLDR / Verge / dev.to feeds when quality demands.

export interface NewsCandidate {
  source: string;       // 'hn'
  sourceId: string;     // 'hn:<numeric item id>'
  title: string;
  url: string;
  domain: string;
  rank: number;         // position in the source's top list (1-indexed)
  score?: number;       // HN points
  commentCount?: number;
  publishedAt?: string; // ISO
  by?: string;
}

const HN = "https://hacker-news.firebaseio.com/v0";

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export async function fetchHnTopStories(limit = 15): Promise<NewsCandidate[]> {
  const ids = (await fetch(`${HN}/topstories.json`).then((r) => r.json())) as number[];
  // Over-fetch so we can skip Ask HN / Show HN / self-posts with no URL.
  const pool = ids.slice(0, Math.min(50, limit * 3));
  const items: (NewsCandidate | null)[] = await Promise.all(
    pool.map(async (id, i): Promise<NewsCandidate | null> => {
      try {
        const it = (await fetch(`${HN}/item/${id}.json`).then((r) => r.json())) as {
          id: number; type?: string; title?: string; url?: string;
          score?: number; descendants?: number; by?: string; time?: number;
        } | null;
        if (!it || it.type !== "story" || !it.url || !it.title) return null;
        return {
          source: "hn",
          sourceId: `hn:${it.id}`,
          title: it.title,
          url: it.url,
          domain: hostOf(it.url),
          rank: i + 1,
          score: it.score,
          commentCount: it.descendants,
          publishedAt: it.time ? new Date(it.time * 1000).toISOString() : undefined,
          by: it.by,
        };
      } catch { return null; }
    })
  );
  return items.filter((x): x is NewsCandidate => !!x).slice(0, limit);
}
