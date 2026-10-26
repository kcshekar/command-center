import { cc } from "../cc-client.js";
import { ollamaJson } from "../ollama.js";

// A7.1 — monthly profile refresh.
//
// Reads the user's profile + recent engagement (A1 news + A8 lessons + any
// briefs) and produces three refreshed artifacts: a LinkedIn headline+bio, a
// GitHub README About section, and a resume summary. Each lands as its own
// knowledge_item so the UI can show/edit them.
//
// Review-only — never writes to GitHub/LinkedIn. The catalog's "opens PRs"
// is a future upgrade when we wire GitHub OAuth.

const PROFILE_ALERT_ROUTE = process.env.PROFILE_ALERT_ROUTE_KEY ?? "automations.digest";

const DEFAULT_PROFILE_REFRESH_PROMPT = `You refresh three short profile artifacts for a senior developer.

Inputs:
- current profile: headline, bio, skills, keywords, years_exp, remote_pref, location
- recent engagement: titles of news stories classified as 'keep' and learning items from the past month

Produce JSON with three fields:
- linkedin: object with headline (<=120 chars, 1 line) and bio (3-4 sentences, first-person, casual-professional)
- readme: a GitHub profile README About section in markdown (5-8 lines, bulleted or short-paragraph, first-person)
- resume: a 2-3 sentence resume summary blurb (third-person, no fluff)

Rules:
- Base everything on the profile. Use recent engagement ONLY for tone/signals (e.g. "backend-heavy weeks → emphasise distributed systems").
- NEVER invent experience, companies, numbers, or accomplishments not in the profile.
- No emoji. No hashtags. No marketing-speak ("ninja", "rockstar", "passionate").
- Return ONLY the JSON. No prose, no preamble.`;

const SCHEMA = {
  type: "object",
  required: ["linkedin", "readme", "resume"],
  properties: {
    linkedin: {
      type: "object",
      required: ["headline", "bio"],
      properties: {
        headline: { type: "string" },
        bio: { type: "string" },
      },
    },
    readme: { type: "string" },
    resume: { type: "string" },
  },
} as const;

interface RefreshDrafts {
  linkedin: { headline: string; bio: string };
  readme: string;
  resume: string;
}

export async function refreshProfileDrafts(input: {
  userId: string;
  recentDays?: number;
  routeKey?: string;
}): Promise<{
  status: "ok" | "no_profile";
  drafted: number;
  briefIds?: string[];
  skippedReason?: string;
}> {
  const profile = await cc.getUserProfile(input.userId);
  if (!profile) {
    return { status: "no_profile", drafted: 0, skippedReason: "no user_profile" };
  }

  // Pull recent engagement: last month of news + lessons titles. Keep it
  // light — just titles are enough for tone signal.
  const [news, lessons] = await Promise.all([
    cc.listKnowledgeItems({ userId: input.userId, source: "a1.news", limit: 50 }).catch(() => []),
    cc.listKnowledgeItems({ userId: input.userId, source: "a8.learning", limit: 50 }).catch(() => []),
  ]);
  const cutoff = Date.now() - (input.recentDays ?? 30) * 86400 * 1000;
  const recentNews = news.filter((n) => new Date(n.createdAt).getTime() > cutoff).map((n) => n.title).slice(0, 20);
  const recentLessons = lessons.filter((l) => new Date(l.createdAt).getTime() > cutoff).map((l) => l.title).slice(0, 20);

  const prompt = (await cc.getEffectivePrompt("profile_refresh", input.userId))?.body
    ?? DEFAULT_PROFILE_REFRESH_PROMPT;

  const full = `${prompt}

Return ONLY JSON matching the schema.

Current profile:
headline: ${profile.headline ?? "—"}
years_exp: ${profile.yearsExp ?? "—"}
remote_pref: ${profile.remotePref}
location: ${profile.location ?? "—"}
skills: ${profile.skills.join(", ")}
keywords: ${profile.keywords.join(", ")}
bio: ${profile.bio ?? "—"}

Recent news engagement (${recentNews.length}):
${recentNews.map((t) => `- ${t}`).join("\n") || "(none)"}

Recent learning (${recentLessons.length}):
${recentLessons.map((t) => `- ${t}`).join("\n") || "(none)"}`;

  const parsed = await ollamaJson(full, SCHEMA) as RefreshDrafts;
  if (!parsed?.linkedin?.headline || !parsed?.readme || !parsed?.resume) {
    return { status: "ok", drafted: 0, skippedReason: "LLM response missing fields" };
  }

  const dayTag = new Date().toISOString().slice(0, 10);
  const briefIds: string[] = [];

  // Three separate knowledge_items so the UI can list/edit each on its own.
  const docs = [
    {
      kind: "linkedin",
      title: `A7 LinkedIn draft — ${dayTag}`,
      body: `# Headline\n\n${parsed.linkedin.headline}\n\n# Bio\n\n${parsed.linkedin.bio}`,
    },
    {
      kind: "readme",
      title: `A7 GitHub README draft — ${dayTag}`,
      body: parsed.readme,
    },
    {
      kind: "resume",
      title: `A7 Resume blurb — ${dayTag}`,
      body: parsed.resume,
    },
  ];

  for (const d of docs) {
    const row = await cc.createKnowledgeItem({
      userId: input.userId,
      type: "profile",
      title: d.title,
      body: d.body,
      tags: ["a7", "profile", d.kind, `date:${dayTag}`],
      source: "a7.profile.draft",
      sourceId: `${d.kind}:${dayTag}`,
      metadata: { kind: d.kind, basedOnNews: recentNews.length, basedOnLessons: recentLessons.length },
    });
    briefIds.push(row.id);
  }

  const text = `🧑‍💻 *A7 Profile refresh — ${dayTag}*

Fresh drafts ready to review (edit before posting anywhere):

*LinkedIn headline:*
_${parsed.linkedin.headline}_

*LinkedIn bio:*
${parsed.linkedin.bio}

*GitHub README About:*
${parsed.readme.length > 500 ? parsed.readme.slice(0, 500) + "\n…" : parsed.readme}

*Resume blurb:*
${parsed.resume}

(Full copies also saved as knowledge items — view the latest on the Profile page when it ships.)`;

  try {
    await cc.notify(input.routeKey ?? PROFILE_ALERT_ROUTE, text);
  } catch (err) {
    console.warn("[a7.profile] slack notify failed", { err: String(err) });
  }

  return { status: "ok", drafted: briefIds.length, briefIds };
}
