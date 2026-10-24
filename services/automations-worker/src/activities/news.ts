import { cc } from "../cc-client.js";
import { fetchHnTopStories, type NewsCandidate } from "../news-sources.js";
import { ollamaJson, ollamaText } from "../ollama.js";

const NEWS_ALERT_ROUTE = process.env.NEWS_ALERT_ROUTE_KEY ?? "automations.digest";

// A1.3 — fallback drafter prompt. Users can override per-org or per-user via
// the Prompts admin + override API from phase 1.6.
const DEFAULT_DRAFTER_PROMPT = `You draft a short twice-weekly LinkedIn post for a senior developer.

Given a list of 3-5 curated tech news stories (each has title, url, topic, importance 1..5, and a short reason), produce a post that:
- opens with ONE sharp sentence naming the common thread (or "a mixed bag" if none)
- lists each story: numbered, title in bold-like markdown (**title**), one-line why it matters, bare URL on its own line
- closes with a short invitation to comment or share

Rules:
- under 1200 characters total
- casual-professional voice, no hype
- NO hashtags unless they're genuinely useful (0-2 max)
- Return ONLY the post text — no preamble, no "Here's your post:", no explanations.`;

// A1.2 — fallback prompt baked into the worker. Users can override via
// POST /api/prompts {name:"news_classifier", ...} (admin) or
// PUT /api/prompts/news_classifier/override (anyone).
const DEFAULT_CLASSIFIER_PROMPT = `You rate a tech news story for a senior developer's twice-weekly LinkedIn digest.

Given a story (title, URL, domain), decide:
- topic: ONE of ['ai','infra','frontend','security','pl','career','hw','sci','biz','other']
- importance: integer 1..5 (5 = must-share headline, 1 = ignore)
- keep: true if worth including in a LinkedIn post for the user
- reason: short phrase explaining the score

Weight signals: novelty, technical depth, quality of source, broad applicability.
Downweight: pure corporate PR, undated opinion, generic listicles.`;

const CLASSIFIER_SCHEMA = {
  type: "object",
  required: ["topic", "importance", "keep"],
  properties: {
    topic: { type: "string", enum: ["ai", "infra", "frontend", "security", "pl", "career", "hw", "sci", "biz", "other"] },
    importance: { type: "integer", minimum: 1, maximum: 5 },
    keep: { type: "boolean" },
    reason: { type: "string" },
  },
} as const;

export interface NewsClassification {
  topic: string;
  importance: number;
  keep: boolean;
  reason?: string;
}

export async function classifyNewsItem(input: {
  userId: string;
  title: string;
  url: string;
  domain: string;
}): Promise<NewsClassification> {
  // Prompt resolution: user override → org default → hardcoded fallback.
  const prompt = (await cc.getEffectivePrompt("news_classifier", input.userId))?.body
    ?? DEFAULT_CLASSIFIER_PROMPT;

  const full = `${prompt}

Return ONLY a JSON object matching the schema. No prose.

Story:
title: ${input.title}
url: ${input.url}
domain: ${input.domain}`;

  const parsed = await ollamaJson(full, CLASSIFIER_SCHEMA) as NewsClassification;
  // Clamp defensively — Ollama can return out-of-range numbers on local models.
  const importance = Math.max(1, Math.min(5, Math.round(Number(parsed.importance) || 1)));
  return {
    topic: parsed.topic,
    importance,
    keep: Boolean(parsed.keep),
    reason: parsed.reason,
  };
}

// A1.1 — plumbing only. Fetch top HN stories and persist each as a
// knowledge_item of type='news' owned by the given user. Idempotency comes
// from the unique (user, source, sourceId) index — reruns are safe.
// Classification + draft + Slack come in A1.2 / A1.3.

export interface ClassifiedStory extends NewsCandidate {
  classification?: NewsClassification;
}

export async function ingestHnTopStories(input: {
  userId: string;
  limit?: number;
  classify?: boolean;
}): Promise<{
  fetched: number; stored: number; classified: number; failed: number;
  stories: ClassifiedStory[];
}> {
  const limit = input.limit ?? 10;
  const classify = input.classify ?? true;
  const candidates = await fetchHnTopStories(limit);
  let stored = 0, classified = 0, failed = 0;
  const stories: ClassifiedStory[] = [];

  for (const c of candidates) {
    let itemId: string;
    try {
      const row = await cc.createKnowledgeItem({
        userId: input.userId,
        type: "news",
        title: c.title,
        body: c.url,
        tags: ["a1", "news", "hn", c.domain].filter(Boolean),
        source: "a1.news",
        sourceId: c.sourceId,
        metadata: {
          url: c.url, domain: c.domain, rank: c.rank,
          score: c.score, commentCount: c.commentCount,
          publishedAt: c.publishedAt, by: c.by, source: c.source,
        },
      });
      stored++;
      itemId = row.id;
    } catch (err) {
      console.warn("[a1.news] persist failed", { sourceId: c.sourceId, err: String(err) });
      failed++;
      continue;
    }

    const story: ClassifiedStory = { ...c };

    if (classify) {
      try {
        const cls = await classifyNewsItem({
          userId: input.userId,
          title: c.title,
          url: c.url,
          domain: c.domain,
        });
        story.classification = cls;
        await cc.patchKnowledgeItemMetadata(itemId, {
          userId: input.userId,
          metadata: { classification: cls, classifiedAt: new Date().toISOString() },
          tags: ["a1", "news", "hn", c.domain, `topic:${cls.topic}`, `imp:${cls.importance}`].filter(Boolean),
        });
        classified++;
      } catch (err) {
        console.warn("[a1.news] classify failed", { sourceId: c.sourceId, err: String(err) });
      }
    }

    stories.push(story);
  }

  return { fetched: candidates.length, stored, classified, failed, stories };
}

// A1.3 — build a short LinkedIn-ready draft from the kept, high-signal
// stories, persist as a knowledge_item (type='brief'), and Slack it.
// Returns the draft text + the brief's id so the UI can later surface edits.
export async function draftAndPostNewsBrief(input: {
  userId: string;
  stories: ClassifiedStory[];
  minImportance?: number;
  routeKey?: string;
}): Promise<{ drafted: boolean; briefId?: string; text?: string; skippedReason?: string }> {
  const minImp = input.minImportance ?? 4;

  // keep=true and importance ≥ minImp; loosen one step if too thin.
  let picks = input.stories.filter((s) => s.classification?.keep && (s.classification?.importance ?? 0) >= minImp);
  if (picks.length < 3) {
    picks = input.stories.filter((s) => s.classification?.keep && (s.classification?.importance ?? 0) >= Math.max(1, minImp - 1));
  }
  // Rank: importance desc, then HN score desc.
  picks.sort((a, b) =>
    (b.classification?.importance ?? 0) - (a.classification?.importance ?? 0)
    || (b.score ?? 0) - (a.score ?? 0)
  );
  picks = picks.slice(0, 5);

  if (picks.length === 0) {
    return { drafted: false, skippedReason: "no kept stories above threshold" };
  }

  const prompt = (await cc.getEffectivePrompt("news_post_drafter", input.userId))?.body
    ?? DEFAULT_DRAFTER_PROMPT;

  const listing = picks.map((p, i) =>
    `${i + 1}. ${p.title}\n   url: ${p.url}\n   topic: ${p.classification?.topic}\n   importance: ${p.classification?.importance}\n   reason: ${p.classification?.reason ?? ""}`
  ).join("\n");

  const full = `${prompt}

Stories to work from:
${listing}`;

  const text = (await ollamaText(full, { temperature: 0.6 })).trim();
  if (!text) return { drafted: false, skippedReason: "empty draft from Ollama" };

  const dayTag = new Date().toISOString().slice(0, 10);
  const briefId = (await cc.createKnowledgeItem({
    userId: input.userId,
    type: "brief",
    title: `A1 news draft — ${dayTag}`,
    body: text,
    tags: ["a1", "news", "draft", `date:${dayTag}`],
    source: "a1.news.draft",
    sourceId: `draft:${dayTag}`,
    metadata: {
      pickedStoryIds: picks.map((p) => p.sourceId),
      pickedCount: picks.length,
      minImportanceUsed: minImp,
    },
  })).id;

  try {
    await cc.notify(input.routeKey ?? NEWS_ALERT_ROUTE,
      `📰 *A1 news draft — ${dayTag}*\n\n${text}`);
  } catch (err) {
    // Draft is already stored; a Slack outage isn't fatal.
    console.warn("[a1.news] slack post failed", { err: String(err) });
    return { drafted: true, briefId, text, skippedReason: "stored but slack failed" };
  }

  return { drafted: true, briefId, text };
}
