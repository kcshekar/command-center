import { cc } from "../cc-client.js";
import { ollamaJson } from "../ollama.js";

// A3.prep — research a job_lead and spin up an interview_session.
//
// Reads the job_lead + user_profile → one Ollama JSON call → persists two
// things: a knowledge_item (type='prep') with the full research, and an
// interview_session (idempotent per source_job_lead_id) tied back to it.
//
// Research is grounded in the posting + user profile only — the model's own
// background on the company is explicitly flagged "may be stale".

const DEFAULT_INTERVIEW_PREP_PROMPT = `You prepare a senior developer for an interview at a specific company for a specific role.

Inputs:
- the job posting (title, company, location, salary, description)
- the dev's profile (headline, bio, skills, years_exp)

Produce JSON with:
- companySummary: 2-3 sentences about the company. If you aren't sure of recent facts, start with "(may be stale) ...". Never invent numbers or news.
- roleSummary: 2-3 sentences on what this role likely involves, grounded in the posting.
- likelyQuestions: 5-8 realistic interview questions tailored to the role (not generic "tell me about yourself").
- questionsToAsk: 3-5 thoughtful questions the dev should ask the interviewer.
- prepTopics: 3-5 topics the dev should brush up on before interviewing (specific — "RocksDB compaction" not "databases").

Rules:
- base everything on the inputs; don't invent experience or company facts you aren't confident about
- no fluff / no "passionate" / no "rockstar"
- Return ONLY the JSON. No preamble.`;

const PREP_SCHEMA = {
  type: "object",
  required: ["companySummary", "roleSummary", "likelyQuestions", "questionsToAsk", "prepTopics"],
  properties: {
    companySummary: { type: "string" },
    roleSummary: { type: "string" },
    likelyQuestions: { type: "array", items: { type: "string" } },
    questionsToAsk:  { type: "array", items: { type: "string" } },
    prepTopics:      { type: "array", items: { type: "string" } },
  },
} as const;

interface PrepResult {
  companySummary: string;
  roleSummary: string;
  likelyQuestions: string[];
  questionsToAsk: string[];
  prepTopics: string[];
}

export async function researchJobLeadForInterview(input: {
  userId: string;
  jobLeadId: string;
}): Promise<{
  status: "ok" | "no_lead" | "no_profile" | "no_company" | "empty_draft";
  sessionId?: string;
  briefId?: string;
  skippedReason?: string;
}> {
  const [lead, profile] = await Promise.all([
    cc.getJobLead(input.jobLeadId, input.userId).catch(() => null),
    cc.getUserProfile(input.userId),
  ]);
  if (!lead) return { status: "no_lead", skippedReason: "job_lead not found" };
  if (!profile) return { status: "no_profile", skippedReason: "user has no profile" };
  if (!lead.company) return { status: "no_company", skippedReason: "lead has no company — scraper gap" };

  const prompt = (await cc.getEffectivePrompt("interview_prep_researcher", input.userId))?.body
    ?? DEFAULT_INTERVIEW_PREP_PROMPT;

  const salary = (lead.salaryMin || lead.salaryMax)
    ? `${lead.salaryMin ?? "?"}-${lead.salaryMax ?? "?"} ${lead.currency ?? ""} ${lead.salaryPeriod ?? ""}`.trim()
    : "not stated";

  const full = `${prompt}

Return ONLY JSON matching the schema.

Job posting:
title: ${lead.title}
company: ${lead.company}
location: ${lead.location ?? "—"}
salary: ${salary}
description:
${(lead.description ?? "").slice(0, 1500)}

Dev profile:
headline: ${profile.headline ?? "—"}
years_exp: ${profile.yearsExp ?? "—"}
skills: ${profile.skills.join(", ")}
bio: ${profile.bio ?? "—"}`;

  const parsed = await ollamaJson(full, PREP_SCHEMA) as PrepResult;
  if (!parsed?.companySummary || !parsed?.roleSummary) {
    return { status: "empty_draft", skippedReason: "LLM response missing required fields" };
  }

  const dayTag = new Date().toISOString().slice(0, 10);
  const prepBody = [
    `# ${lead.company} — ${lead.title}`,
    "",
    `_Prep notes drafted ${dayTag} • [source posting](${lead.url})_`,
    "",
    "## Company",
    parsed.companySummary,
    "",
    "## Role",
    parsed.roleSummary,
    "",
    "## Likely interview questions",
    ...parsed.likelyQuestions.map((q) => `- ${q}`),
    "",
    "## Questions to ask",
    ...parsed.questionsToAsk.map((q) => `- ${q}`),
    "",
    "## Topics to brush up on",
    ...parsed.prepTopics.map((t) => `- ${t}`),
  ].join("\n");

  const brief = await cc.createKnowledgeItem({
    userId: input.userId,
    type: "prep",
    title: `A3 prep — ${lead.company} / ${lead.title}`,
    body: prepBody,
    tags: ["a3", "prep", `date:${dayTag}`, `lead:${input.jobLeadId}`],
    source: "a3.prep",
    sourceId: `job:${input.jobLeadId}`,
    metadata: {
      jobLeadId: input.jobLeadId,
      company: lead.company,
      role: lead.title,
      counts: {
        likelyQuestions: parsed.likelyQuestions.length,
        questionsToAsk: parsed.questionsToAsk.length,
        prepTopics: parsed.prepTopics.length,
      },
    },
  });

  const shortSummary = `${parsed.companySummary.slice(0, 160)}\n\n**Topics to brush up:** ${parsed.prepTopics.slice(0, 3).join(" · ")}`;

  const session = await cc.upsertInterviewSession({
    userId: input.userId,
    company: lead.company,
    role: lead.title,
    sourceJobLeadId: input.jobLeadId,
    notes: shortSummary,
    metadata: { prepKnowledgeItemId: brief.id, lastResearchedAt: new Date().toISOString() },
  });

  // Fire-and-forget SSE push — UI (/jobs or /interviews) refreshes when live.
  try {
    await cc.emitEvent({
      userId: input.userId,
      type: "interview_prep:completed",
      payload: { jobLeadId: input.jobLeadId, sessionId: session.id, briefId: brief.id },
    });
  } catch { /* best-effort */ }

  return { status: "ok", sessionId: session.id, briefId: brief.id };
}
