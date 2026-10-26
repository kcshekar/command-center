import { cc } from "../cc-client.js";
import { fetchGithubReleases, fetchDevToTagArticles, fetchRssFeed, type LearningCandidate } from "../learning-sources.js";
import { ollamaJson, ollamaText } from "../ollama.js";

const LEARNING_ALERT_ROUTE = process.env.LEARNING_ALERT_ROUTE_KEY ?? "automations.digest";

// A8.2 — fallback prompts, overridable via the Prompts admin + override API.
const DEFAULT_LEARNING_CLASSIFIER_PROMPT = `You rate a software release / learning item for a senior developer's weekly digest.

Given (title, url, kind, target, summary), decide:
- priority: ONE of ['must','skim','skip']
  must  = headline-level change, must know
  skim  = worth a glance, mostly incremental
  skip  = minor patch, duplicate, or off-topic
- rationale: short phrase explaining the call

Weight signals: breaking changes, new features, security fixes, performance work, deprecations. Downweight: typo fixes, dependency bumps, release-note churn with no behaviour change.`;

const CLASSIFIER_SCHEMA = {
  type: "object",
  required: ["priority"],
  properties: {
    priority: { type: "string", enum: ["must", "skim", "skip"] },
    rationale: { type: "string" },
  },
} as const;

export interface LessonClassification {
  priority: "must" | "skim" | "skip";
  rationale?: string;
}

const DEFAULT_LEARNING_DIGEST_PROMPT = `You write a short weekly learning digest for a senior developer.

Given a list of items (title, url, target, priority, rationale), produce a Slack post that:
- opens with ONE sharp sentence summarising the theme ("quiet week", "runtime churn", "security-heavy", ...)
- has a *Must read* list of 'must' items (numbered, title → one-line why, URL on its own line)
- has a *Worth a skim* list of 'skim' items (one-liners, not numbered)
- if both lists are empty, say "nothing noteworthy this week" and stop

Rules:
- under 1200 characters total
- casual-professional voice
- NO hashtags, NO emoji in the body (one 📚 opener is OK)
- Return ONLY the post text — no preamble.`;

// A8.1 — pull new material for each enabled learning_goal into
// knowledge_items. One row per release / article; type='lesson',
// source='a8.learning', sourceId guarantees idempotency across reruns.

export interface ClassifiedLesson extends LearningCandidate {
  classification?: LessonClassification;
}

export async function classifyLessonItem(input: {
  userId: string;
  title: string;
  url: string;
  kind: string;
  target: string;
  summary?: string;
}): Promise<LessonClassification> {
  const prompt = (await cc.getEffectivePrompt("learning_classifier", input.userId))?.body
    ?? DEFAULT_LEARNING_CLASSIFIER_PROMPT;

  const full = `${prompt}

Return ONLY a JSON object matching the schema. No prose.

Item:
title: ${input.title}
url: ${input.url}
kind: ${input.kind}
target: ${input.target}
summary: ${(input.summary ?? "").slice(0, 400)}`;

  const parsed = await ollamaJson(full, CLASSIFIER_SCHEMA) as LessonClassification;
  const priority = (["must", "skim", "skip"] as const).includes(parsed.priority) ? parsed.priority : "skip";
  return { priority, rationale: parsed.rationale };
}

export async function ingestLearningReleases(input: {
  userId: string;
  daysBack?: number;
  perRepo?: number;
  classify?: boolean;
}): Promise<{
  goals: number; fetched: number; stored: number; classified: number; failed: number;
  lessons: ClassifiedLesson[];
}> {
  const daysBack = input.daysBack ?? 7;
  const classify = input.classify ?? true;
  const sinceIso = new Date(Date.now() - daysBack * 86400 * 1000).toISOString();

  const goals = await cc.listLearningGoals(input.userId);
  const perRepo = input.perRepo ?? 5;

  // Fan out per source_kind. Each adapter returns the same LearningCandidate
  // shape so classification + draft stay source-agnostic.
  const candidates: LearningCandidate[] = [];
  for (const g of goals) {
    try {
      if (g.sourceKind === "github_release") {
        candidates.push(...await fetchGithubReleases(g.target, sinceIso, perRepo));
      } else if (g.sourceKind === "dev_to_tag") {
        candidates.push(...await fetchDevToTagArticles(g.target, sinceIso, perRepo));
      } else if (g.sourceKind === "rss") {
        candidates.push(...await fetchRssFeed(g.target, sinceIso, perRepo));
      } else {
        console.warn("[a8.learning] unknown source_kind, skipping", { kind: g.sourceKind, target: g.target });
      }
    } catch (err) {
      console.warn("[a8.learning] fetcher failed", { kind: g.sourceKind, target: g.target, err: String(err) });
    }
  }

  let stored = 0, classified = 0, failed = 0;
  const lessons: ClassifiedLesson[] = [];

  for (const c of candidates) {
    let itemId: string;
    try {
      const row = await cc.createKnowledgeItem({
        userId: input.userId,
        type: "lesson",
        title: c.title,
        body: c.summary ?? c.url,
        tags: ["a8", "learning", c.kind, c.target.replace(/\//g, "-")].filter(Boolean),
        source: c.source,
        sourceId: c.sourceId,
        metadata: {
          url: c.url, publishedAt: c.publishedAt,
          kind: c.kind, target: c.target,
          meta: c.meta ?? {},
        },
      });
      stored++;
      itemId = row.id;
    } catch (err) {
      console.warn("[a8.learning] persist failed", { sourceId: c.sourceId, err: String(err) });
      failed++;
      continue;
    }

    const lesson: ClassifiedLesson = { ...c };

    if (classify) {
      try {
        const cls = await classifyLessonItem({
          userId: input.userId,
          title: c.title, url: c.url, kind: c.kind, target: c.target,
          summary: c.summary,
        });
        lesson.classification = cls;
        await cc.patchKnowledgeItemMetadata(itemId, {
          userId: input.userId,
          metadata: { classification: cls, classifiedAt: new Date().toISOString() },
          tags: ["a8", "learning", c.kind, c.target.replace(/\//g, "-"), `prio:${cls.priority}`].filter(Boolean),
        });
        classified++;
      } catch (err) {
        console.warn("[a8.learning] classify failed", { sourceId: c.sourceId, err: String(err) });
      }
    }

    lessons.push(lesson);
  }

  return { goals: goals.length, fetched: candidates.length, stored, classified, failed, lessons };
}

// A8.2 — build the weekly digest from the classified lessons and Slack it.
// Persists the digest as a knowledge_item (type='brief', source='a8.learning.draft')
// so it's recoverable from the UI later.
export async function draftAndPostLearningDigest(input: {
  userId: string;
  lessons: ClassifiedLesson[];
  routeKey?: string;
}): Promise<{ drafted: boolean; briefId?: string; text?: string; skippedReason?: string }> {
  const must = input.lessons.filter((l) => l.classification?.priority === "must");
  const skim = input.lessons.filter((l) => l.classification?.priority === "skim");
  const totalKept = must.length + skim.length;

  if (totalKept === 0) {
    // Still post a short "nothing noteworthy" line so you know the sweep ran.
    const dayTag = new Date().toISOString().slice(0, 10);
    const text = `📚 *Weekly learning digest — ${dayTag}*\n\nQuiet week — no releases worth highlighting across your learning goals.`;
    try { await cc.notify(input.routeKey ?? LEARNING_ALERT_ROUTE, text); } catch {}
    return { drafted: true, text, skippedReason: "no must/skim items" };
  }

  const prompt = (await cc.getEffectivePrompt("learning_digest_drafter", input.userId))?.body
    ?? DEFAULT_LEARNING_DIGEST_PROMPT;

  const render = (l: ClassifiedLesson) =>
    `- title: ${l.title}\n  url: ${l.url}\n  target: ${l.target}\n  priority: ${l.classification?.priority}\n  rationale: ${l.classification?.rationale ?? ""}`;

  const full = `${prompt}

Items this week:
${[...must, ...skim].map(render).join("\n")}`;

  const text = (await ollamaText(full, { temperature: 0.5 })).trim();
  if (!text) return { drafted: false, skippedReason: "empty draft from Ollama" };

  const dayTag = new Date().toISOString().slice(0, 10);
  const briefId = (await cc.createKnowledgeItem({
    userId: input.userId,
    type: "brief",
    title: `A8 learning digest — ${dayTag}`,
    body: text,
    tags: ["a8", "learning", "digest", `date:${dayTag}`],
    source: "a8.learning.draft",
    sourceId: `digest:${dayTag}`,
    metadata: {
      mustCount: must.length,
      skimCount: skim.length,
      sourceIds: [...must, ...skim].map((l) => l.sourceId),
    },
  })).id;

  try {
    await cc.notify(input.routeKey ?? LEARNING_ALERT_ROUTE,
      `📚 *Weekly learning digest — ${dayTag}*\n\n${text}`);
  } catch (err) {
    console.warn("[a8.learning] slack post failed", { err: String(err) });
    return { drafted: true, briefId, text, skippedReason: "stored but slack failed" };
  }

  return { drafted: true, briefId, text };
}
