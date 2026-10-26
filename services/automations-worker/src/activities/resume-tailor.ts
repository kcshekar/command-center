import { cc } from "../cc-client.js";
import { gmailClient } from "../google-oauth.js";
import { ollamaJson } from "../ollama.js";

// A9.resume — tailor a resume + cover letter from the user's profile + the
// job posting, persist both as knowledge_items, and (if we have the user's
// Google OAuth) stage a Gmail draft so the user just needs to add the
// recipient and send.
//
// Resume is NOT a template file — the output is markdown the user can paste
// into whichever template they maintain outside the automation. The brief
// stays side-by-side with the A3.prep research under /interviews later.

const DEFAULT_RESUME_TAILOR_PROMPT = `You tailor a senior developer's resume + cover letter for a specific job posting.

Inputs:
- the dev's profile (headline, bio, skills, keywords, years_exp, location)
- the job posting (title, company, location, salary, description)
- optionally, the dev's most recent A7 resume blurb to extend from

Produce JSON with three fields:
- highlights: array of 4-7 one-line resume bullets that would resonate for THIS role. Each must be grounded in the profile — never invent experience, numbers, or companies the dev hasn't claimed.
- tailoredResume: a short markdown resume (headline, 3-sentence summary, 'Highlights for this role' section with the bullets above, 'Core skills' line). Keep under ~1500 chars.
- coverLetter: a 3-4 paragraph plain-text cover letter addressed to the hiring manager, mentioning the role + company by name. Open with ONE sentence hook grounded in a profile fact. Avoid "passionate", "excited", "I would love", "ninja", "rockstar". No emoji.

Rules:
- never invent facts
- if the posting lacks info (e.g. no company tone), stay neutral
- Return ONLY the JSON. No preamble.`;

const SCHEMA = {
  type: "object",
  required: ["highlights", "tailoredResume", "coverLetter"],
  properties: {
    highlights:     { type: "array", items: { type: "string" } },
    tailoredResume: { type: "string" },
    coverLetter:    { type: "string" },
  },
} as const;

interface TailoredDrafts {
  highlights: string[];
  tailoredResume: string;
  coverLetter: string;
}

export async function tailorResumeForJobLead(input: {
  userId: string;
  userEmail?: string;         // if set, we also create a Gmail draft
  jobLeadId: string;
}): Promise<{
  status: "ok" | "no_lead" | "no_profile" | "no_company" | "empty_draft";
  resumeKnowledgeItemId?: string;
  coverLetterKnowledgeItemId?: string;
  gmailDraftId?: string;
  gmailDraftSkippedReason?: string;
  skippedReason?: string;
}> {
  const [lead, profile] = await Promise.all([
    cc.getJobLead(input.jobLeadId, input.userId).catch(() => null),
    cc.getUserProfile(input.userId),
  ]);
  if (!lead) return { status: "no_lead", skippedReason: "job_lead not found" };
  if (!profile) return { status: "no_profile", skippedReason: "user has no profile" };
  if (!lead.company) return { status: "no_company", skippedReason: "lead has no company" };

  // Grab the most recent A7 resume blurb as prior context (optional).
  const priorResume = await cc
    .listKnowledgeItems({ userId: input.userId, source: "a7.profile.draft", type: "profile", limit: 20 })
    .then((rows) => rows.find((r) => r.sourceId?.startsWith("resume:")) ?? null)
    .catch(() => null);

  const prompt = (await cc.getEffectivePrompt("resume_tailor", input.userId))?.body
    ?? DEFAULT_RESUME_TAILOR_PROMPT;

  const salary = (lead.salaryMin || lead.salaryMax)
    ? `${lead.salaryMin ?? "?"}-${lead.salaryMax ?? "?"} ${lead.currency ?? ""} ${lead.salaryPeriod ?? ""}`.trim()
    : "not stated";

  const full = `${prompt}

Return ONLY JSON matching the schema.

Dev profile:
headline: ${profile.headline ?? "—"}
years_exp: ${profile.yearsExp ?? "—"}
location: ${profile.location ?? "—"}
skills: ${profile.skills.join(", ")}
keywords: ${profile.keywords.join(", ")}
bio: ${profile.bio ?? "—"}
${priorResume ? `\nPrior A7 resume blurb:\n${(priorResume as unknown as { title: string }).title}` : ""}

Job posting:
title: ${lead.title}
company: ${lead.company}
location: ${lead.location ?? "—"}
salary: ${salary}
description:
${(lead.description ?? "").slice(0, 1500)}`;

  const parsed = await ollamaJson(full, SCHEMA) as TailoredDrafts;
  if (!parsed?.tailoredResume || !parsed?.coverLetter) {
    return { status: "empty_draft", skippedReason: "LLM response missing fields" };
  }

  const dayTag = new Date().toISOString().slice(0, 10);
  const dayId = `${dayTag}`;

  const resumeBrief = await cc.createKnowledgeItem({
    userId: input.userId,
    type: "resume",
    title: `A9 resume — ${lead.company} / ${lead.title}`,
    body: parsed.tailoredResume,
    tags: ["a9", "resume", `date:${dayTag}`, `lead:${input.jobLeadId}`],
    source: "a9.resume",
    sourceId: `job:${input.jobLeadId}:resume:${dayId}`,
    metadata: {
      jobLeadId: input.jobLeadId, company: lead.company, role: lead.title,
      highlightCount: parsed.highlights.length,
    },
  });

  const coverBrief = await cc.createKnowledgeItem({
    userId: input.userId,
    type: "cover_letter",
    title: `A9 cover letter — ${lead.company} / ${lead.title}`,
    body: parsed.coverLetter,
    tags: ["a9", "cover_letter", `date:${dayTag}`, `lead:${input.jobLeadId}`],
    source: "a9.resume",
    sourceId: `job:${input.jobLeadId}:cover:${dayId}`,
    metadata: { jobLeadId: input.jobLeadId, company: lead.company, role: lead.title },
  });

  // Gmail draft is a nice-to-have — missing OAuth or missing userEmail just
  // means "we skipped it, the two knowledge_items are still ready".
  let gmailDraftId: string | undefined;
  let gmailDraftSkippedReason: string | undefined;
  if (input.userEmail) {
    try {
      const gmail = await gmailClient(input.userEmail);
      const subject = `Application: ${lead.title} — ${profile.headline ?? "candidate"}`;
      const lines = [
        `To: `,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset="utf-8"`,
        `MIME-Version: 1.0`,
        ``,
        parsed.coverLetter,
      ];
      const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
      const draft = await gmail.users.drafts.create({
        userId: "me",
        requestBody: { message: { raw } },
      });
      gmailDraftId = draft.data.id ?? undefined;
    } catch (err) {
      gmailDraftSkippedReason = String(err).slice(0, 160);
      console.warn("[a9.resume] gmail draft failed", { err: String(err) });
    }
  } else {
    gmailDraftSkippedReason = "no userEmail";
  }

  // Patch the interview_session for this lead (if one exists from A3.prep)
  // with pointers to the drafts, so slice 4's /interviews page can surface them.
  try {
    await cc.upsertInterviewSession({
      userId: input.userId,
      company: lead.company,
      role: lead.title,
      sourceJobLeadId: input.jobLeadId,
      metadata: {
        resumeKnowledgeItemId: resumeBrief.id,
        coverLetterKnowledgeItemId: coverBrief.id,
        gmailDraftId,
        tailoredAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.warn("[a9.resume] session patch failed", { err: String(err) });
  }

  try {
    await cc.emitEvent({
      userId: input.userId,
      type: "resume_tailor:completed",
      payload: {
        jobLeadId: input.jobLeadId,
        resumeKnowledgeItemId: resumeBrief.id,
        coverLetterKnowledgeItemId: coverBrief.id,
        gmailDraftId,
      },
    });
  } catch { /* best-effort */ }

  return {
    status: "ok",
    resumeKnowledgeItemId: resumeBrief.id,
    coverLetterKnowledgeItemId: coverBrief.id,
    gmailDraftId,
    gmailDraftSkippedReason,
  };
}
