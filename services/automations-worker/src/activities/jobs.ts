import { cc } from "../cc-client.js";
import {
  fetchAdzunaJobs, fetchSerpApiJobs, fetchJSearchJobs,
  type JobCandidate,
} from "../job-sources.js";
import { ollamaJson, ollamaText } from "../ollama.js";

const JOBS_ALERT_ROUTE = process.env.JOBS_ALERT_ROUTE_KEY ?? "automations.digest";

const DEFAULT_JOBS_DIGEST_PROMPT = `You draft a short daily shortlist of job matches for a senior developer.

Given a list of pre-scored jobs (title, company, location, salary band, score 1-5, reason), produce a Slack post that:
- opens with ONE sharp sentence summarising the batch ("4 strong matches today", "slim pickings this run", ...)
- lists each kept job: numbered, *title at company* — one-line why it matches, bare URL on its own line
- closes with a short invitation to action ("worth a 10-min scan each", "apply to the top one by EOD?", ...)

Rules:
- under 1500 characters total
- casual-professional voice
- NO hashtags, max 1-2 emoji
- Return ONLY the post text — no preamble.`;

// A2.2 — Adzuna ingest. Resolves the user's profile for keywords/location/
// min-salary, pulls their Adzuna BYOK key (key = app_key, metadata.appId =
// app_id), fetches jobs, upserts each via the integration endpoint.
//
// A2.3 — if `classify:true`, score each stored lead with Ollama against the
// user's profile.bio + skills, then PATCH back score + reason.

const DEFAULT_JOB_SCORER_PROMPT = `You rate a job posting for fit against a specific developer's profile.

Given:
- the dev's headline + bio + skills + keywords + years_exp + remote_pref
- the job's title, company, location, salary band, and description snippet

Decide:
- score: integer 1..5 — fit (5 = must apply, 1 = ignore)
- reason: short phrase explaining the score

Weight signals: skill overlap, seniority match, remote/location fit, salary band
(if present) vs min_salary, red flags (contract roles when dev wants perm, etc).
Don't invent facts not in the posting.`;

const SCORER_SCHEMA = {
  type: "object",
  required: ["score"],
  properties: {
    score: { type: "integer", minimum: 1, maximum: 5 },
    reason: { type: "string" },
  },
} as const;

async function scoreJobForProfile(input: {
  userId: string;
  profile: NonNullable<Awaited<ReturnType<typeof cc.getUserProfile>>>;
  lead: JobCandidate & { currency: string | null };
}): Promise<{ score: number; reason?: string }> {
  const prompt = (await cc.getEffectivePrompt("job_scorer", input.userId))?.body
    ?? DEFAULT_JOB_SCORER_PROMPT;

  const salary = (input.lead.salaryMin || input.lead.salaryMax)
    ? `${input.lead.salaryMin ?? "?"} - ${input.lead.salaryMax ?? "?"} ${input.lead.currency ?? ""} ${input.lead.salaryPeriod ?? ""}`.trim()
    : "not stated";

  const full = `${prompt}

Return ONLY a JSON object matching the schema. No prose.

Dev profile:
headline: ${input.profile.headline ?? "—"}
years_exp: ${input.profile.yearsExp ?? "—"}
remote_pref: ${input.profile.remotePref}
min_salary: ${input.profile.minSalaryLpa ?? "—"} ${input.profile.currency}
skills: ${input.profile.skills.join(", ")}
keywords: ${input.profile.keywords.join(", ")}
bio: ${input.profile.bio ?? "—"}

Job:
title: ${input.lead.title}
company: ${input.lead.company ?? "—"}
location: ${input.lead.location ?? "—"}
salary: ${salary}
description: ${(input.lead.description ?? "").slice(0, 600)}`;

  const parsed = await ollamaJson(full, SCORER_SCHEMA) as { score: number; reason?: string };
  const score = Math.max(1, Math.min(5, Math.round(Number(parsed.score) || 1)));
  return { score, reason: parsed.reason };
}

const CURRENCY_BY_COUNTRY: Record<string, string> = {
  in: "INR", us: "USD", gb: "GBP", de: "EUR", fr: "EUR",
  ca: "CAD", au: "AUD", sg: "SGD", nl: "EUR", br: "BRL",
};

export type IngestStatus =
  | "ok" | "no_profile" | "no_credential" | "no_app_id" | "no_keywords";

export interface ScoredLead {
  id: string;
  sourceId: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  salaryPeriod: string | null;
  description: string | null;
  score?: number;
  scoreReason?: string;
}

export async function ingestAdzunaJobs(input: {
  userId: string;
  country?: string;
  resultsPerPage?: number;
  classify?: boolean;
}): Promise<{
  status: IngestStatus; fetched: number; stored: number; scored: number; failed: number;
  keywords?: string; country?: string;
  leads: ScoredLead[];
}> {
  const classify = input.classify ?? true;
  const profile = await cc.getUserProfile(input.userId);
  if (!profile) return { status: "no_profile", fetched: 0, stored: 0, scored: 0, failed: 0, leads: [] };
  if (profile.keywords.length === 0) {
    return { status: "no_keywords", fetched: 0, stored: 0, scored: 0, failed: 0, leads: [] };
  }

  const cred = await cc.getUserCredential(input.userId, "adzuna");
  if (!cred) return { status: "no_credential", fetched: 0, stored: 0, scored: 0, failed: 0, leads: [] };
  const appId = typeof cred.metadata?.appId === "string"
    ? cred.metadata.appId
    : typeof cred.metadata?.app_id === "string"
      ? cred.metadata.app_id : null;
  if (!appId) return { status: "no_app_id", fetched: 0, stored: 0, scored: 0, failed: 0, leads: [] };

  // Country: input override → explicit profile.metadata.jobsCountry → derive
  // from the profile.currency → fall back to 'in'.
  const country = (input.country
    ?? (typeof profile.metadata?.jobsCountry === "string" ? profile.metadata.jobsCountry : null)
    ?? (Object.entries(CURRENCY_BY_COUNTRY).find(([, c]) => c === profile.currency)?.[0])
    ?? "in").toLowerCase();
  const currency = CURRENCY_BY_COUNTRY[country] ?? profile.currency;

  // Adzuna salary filter is in local currency (annual). profile.min_salary_lpa
  // is in INR LPA; convert for 'in', otherwise pass through if same currency.
  let salaryMin: number | undefined;
  if (profile.minSalaryLpa && profile.minSalaryLpa > 0) {
    if (country === "in") salaryMin = profile.minSalaryLpa * 100000; // LPA → absolute
    else if (currency === profile.currency) salaryMin = profile.minSalaryLpa * 100000; // best-effort
  }

  const what = profile.keywords.slice(0, 6).join(" ");       // Adzuna caps query length
  // Adzuna's `where` parser dies if the string ends with ", <country>"
  // ("Hyderabad, IN" → 0 results; "Hyderabad" → 1k+). Strip the trailing
  // comma segment so natural user input doesn't silently filter everything.
  const where = (profile.location ?? "").replace(/,\s*[A-Za-z. ]{2,}$/, "").trim();

  const perPage = input.resultsPerPage ?? 25;

  // Fan out across whichever BYOK keys the user has. Adzuna is the first-class
  // source (we already resolved its key for appId/key); SerpAPI + JSearch are
  // soft-fetched (missing key → skipped), so this just widens coverage if the
  // user has them.
  const candidates: JobCandidate[] = [];
  const sourcesTried: string[] = [];
  const sourceErrors: Record<string, string> = {};

  try {
    sourcesTried.push("adzuna");
    const r = await fetchAdzunaJobs({ appId, appKey: cred.key, country, what, where, salaryMin, resultsPerPage: perPage });
    candidates.push(...r);
  } catch (err) {
    sourceErrors["adzuna"] = String(err).slice(0, 120);
  }

  const serpCred = await cc.getUserCredential(input.userId, "serpapi").catch(() => null);
  if (serpCred) {
    sourcesTried.push("serpapi");
    try {
      const r = await fetchSerpApiJobs({ apiKey: serpCred.key, what, where, country, resultsPerPage: perPage });
      candidates.push(...r);
    } catch (err) {
      sourceErrors["serpapi"] = String(err).slice(0, 120);
    }
  }

  const jsearchCred = await cc.getUserCredential(input.userId, "jsearch").catch(() => null);
  if (jsearchCred) {
    sourcesTried.push("jsearch");
    try {
      const r = await fetchJSearchJobs({ apiKey: jsearchCred.key, what, where, country, resultsPerPage: perPage });
      candidates.push(...r);
    } catch (err) {
      sourceErrors["jsearch"] = String(err).slice(0, 120);
    }
  }

  // Dedupe by (source, sourceId) — a repeat run of the same source gets its
  // own CC-side upsert, but we don't want to double-process the same posting
  // inside one activity call.
  console.log("[a2.jobs] fan-out", { sourcesTried, sourceErrors, totalCandidates: candidates.length });
  const seen = new Set<string>();
  const anti = profile.antiKeywords.map((k) => k.toLowerCase());
  const filtered = candidates.filter((c) => {
    const key = `${c.source}:${c.sourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return !anti.some((bad) => c.title.toLowerCase().includes(bad));
  });

  let stored = 0, scored = 0, failed = 0;
  const leads: ScoredLead[] = [];
  for (const c of filtered) {
    let leadId: string;
    try {
      const row = await cc.upsertJobLead({
        userId: input.userId,
        source: c.source, sourceId: c.sourceId,
        title: c.title, url: c.url,
        company: c.company, location: c.location,
        salaryMin: c.salaryMin, salaryMax: c.salaryMax,
        currency, salaryPeriod: c.salaryPeriod,
        description: c.description, postedAt: c.postedAt,
        metadata: {
          country, searchQuery: what, searchLocation: where,
          raw: c.meta ?? {},
        },
      });
      stored++;
      leadId = row.id;
    } catch (err) {
      console.warn("[a2.jobs] upsert failed", { sourceId: c.sourceId, err: String(err) });
      failed++;
      continue;
    }

    const lead: ScoredLead = {
      id: leadId, sourceId: c.sourceId,
      title: c.title, company: c.company, location: c.location, url: c.url,
      salaryMin: c.salaryMin, salaryMax: c.salaryMax,
      currency, salaryPeriod: c.salaryPeriod, description: c.description,
    };

    if (classify) {
      try {
        const result = await scoreJobForProfile({
          userId: input.userId, profile,
          lead: { ...c, currency },
        });
        await cc.scoreJobLead(leadId, {
          userId: input.userId,
          score: result.score,
          reason: result.reason,
        });
        lead.score = result.score;
        lead.scoreReason = result.reason;
        scored++;
      } catch (err) {
        console.warn("[a2.jobs] score failed", { sourceId: c.sourceId, err: String(err) });
      }
    }
    leads.push(lead);
  }

  return { status: "ok", fetched: candidates.length, stored, scored, failed, keywords: what, country, leads };
}

// A2.4 — pick top matches from the just-scored run and Slack a digest. Draft
// is persisted as a knowledge_item (type='brief', source='a2.jobs.draft')
// idempotent per date, so re-runs on the same day replace rather than stack.
export async function draftAndPostJobsDigest(input: {
  userId: string;
  leads: ScoredLead[];
  minScore?: number;
  routeKey?: string;
}): Promise<{ drafted: boolean; briefId?: string; text?: string; skippedReason?: string }> {
  const minScore = input.minScore ?? 4;

  let picks = input.leads.filter((l) => (l.score ?? 0) >= minScore);
  if (picks.length < 3) {
    picks = input.leads.filter((l) => (l.score ?? 0) >= Math.max(1, minScore - 1));
  }
  picks.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  picks = picks.slice(0, 6);

  const dayTag = new Date().toISOString().slice(0, 10);

  if (picks.length === 0) {
    const text = `💼 *Daily jobs digest — ${dayTag}*\n\nSlim pickings this run — nothing above score ${minScore - 1}.`;
    try { await cc.notify(input.routeKey ?? JOBS_ALERT_ROUTE, text); } catch {}
    return { drafted: true, text, skippedReason: "no leads above threshold" };
  }

  const prompt = (await cc.getEffectivePrompt("jobs_digest_drafter", input.userId))?.body
    ?? DEFAULT_JOBS_DIGEST_PROMPT;

  const render = (l: ScoredLead) => {
    const salary = (l.salaryMin || l.salaryMax)
      ? `${l.salaryMin ?? "?"}-${l.salaryMax ?? "?"} ${l.currency ?? ""} ${l.salaryPeriod ?? ""}`.trim()
      : "not stated";
    return `- title: ${l.title}\n  company: ${l.company ?? "—"}\n  location: ${l.location ?? "—"}\n  salary: ${salary}\n  score: ${l.score}\n  reason: ${l.scoreReason ?? ""}\n  url: ${l.url}`;
  };

  const full = `${prompt}

Picks:
${picks.map(render).join("\n")}`;

  const text = (await ollamaText(full, { temperature: 0.5 })).trim();
  if (!text) return { drafted: false, skippedReason: "empty draft from Ollama" };

  const briefId = (await cc.createKnowledgeItem({
    userId: input.userId,
    type: "brief",
    title: `A2 jobs digest — ${dayTag}`,
    body: text,
    tags: ["a2", "jobs", "digest", `date:${dayTag}`],
    source: "a2.jobs.draft",
    sourceId: `digest:${dayTag}`,
    metadata: {
      picked: picks.length,
      minScoreUsed: minScore,
      leadIds: picks.map((p) => p.id),
    },
  })).id;

  try {
    await cc.notify(input.routeKey ?? JOBS_ALERT_ROUTE,
      `💼 *Daily jobs digest — ${dayTag}*\n\n${text}`);
  } catch (err) {
    console.warn("[a2.jobs] slack post failed", { err: String(err) });
    return { drafted: true, briefId, text, skippedReason: "stored but slack failed" };
  }

  return { drafted: true, briefId, text };
}
