import { apiFetch } from "./api";

export const SESSION_STATUSES = ["researching", "applied", "interviewing", "offered", "rejected", "withdrawn"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const ROUND_KINDS = ["phone_screen", "technical", "system_design", "behavioral", "onsite", "bar_raiser", "other"] as const;
export type RoundKind = (typeof ROUND_KINDS)[number];

export const ROUND_OUTCOMES = ["passed", "failed", "pending"] as const;
export type RoundOutcome = (typeof ROUND_OUTCOMES)[number];

export interface InterviewSession {
  id: string;
  company: string;
  role: string;
  sourceJobLeadId: string | null;
  status: SessionStatus;
  appliedAt: string | null;
  decisionAt: string | null;
  notes: string | null;
  metadata: {
    prepKnowledgeItemId?: string;
    resumeKnowledgeItemId?: string;
    coverLetterKnowledgeItemId?: string;
    gmailDraftId?: string;
    tailoredAt?: string;
    lastResearchedAt?: string;
    [k: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
  roundCount?: number;
}

export interface InterviewRound {
  id: string;
  sessionId: string;
  kind: RoundKind;
  scheduledAt: string | null;
  durationMin: number | null;
  interviewer: string | null;
  notes: string | null;
  outcome: RoundOutcome | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface InterviewSessionDetail extends InterviewSession {
  rounds: InterviewRound[];
}

export const interviewsApi = {
  listSessions: (status?: SessionStatus) =>
    apiFetch<InterviewSession[]>(`/interview-sessions${status ? "?status=" + status : ""}`),
  getSession: (id: string) =>
    apiFetch<InterviewSessionDetail>(`/interview-sessions/${id}`),
  createSession: (input: { company: string; role: string; status?: SessionStatus; notes?: string | null }) =>
    apiFetch<InterviewSession>(`/interview-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  updateSession: (id: string, input: Partial<{ company: string; role: string; status: SessionStatus; appliedAt: string | null; decisionAt: string | null; notes: string | null }>) =>
    apiFetch<InterviewSession>(`/interview-sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  deleteSession: (id: string) =>
    apiFetch(`/interview-sessions/${id}`, { method: "DELETE" }),

  createRound: (input: { sessionId: string; kind: RoundKind; scheduledAt?: string | null; durationMin?: number | null; interviewer?: string | null; notes?: string | null; outcome?: RoundOutcome | null }) =>
    apiFetch<InterviewRound>(`/interview-rounds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  updateRound: (id: string, input: Partial<{ kind: RoundKind; scheduledAt: string | null; durationMin: number | null; interviewer: string | null; notes: string | null; outcome: RoundOutcome | null }>) =>
    apiFetch<InterviewRound>(`/interview-rounds/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  deleteRound: (id: string) =>
    apiFetch(`/interview-rounds/${id}`, { method: "DELETE" }),
};

// Knowledge items linked from session metadata (prep / resume / cover letter).
export interface InterviewLinkedDoc {
  id: string;
  title: string;
  body: string | null;
  type: string;
  createdAt: string;
  updatedAt: string;
}

export const linkedDocsApi = {
  get: (id: string) => apiFetch<InterviewLinkedDoc>(`/knowledge-items/${id}`),
};
