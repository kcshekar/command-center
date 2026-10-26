import { apiFetch } from "./api";

export const REMOTE_PREFS = ["remote", "hybrid", "onsite", "any"] as const;
export type RemotePref = (typeof REMOTE_PREFS)[number];

export interface UserProfile {
  id: string;
  headline: string | null;
  yearsExp: number | null;
  location: string | null;
  remotePref: RemotePref;
  minSalaryLpa: number | null;
  currency: string;
  skills: string[];
  keywords: string[];
  antiKeywords: string[];
  bio: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfileInput {
  headline?: string | null;
  yearsExp?: number | null;
  location?: string | null;
  remotePref?: RemotePref;
  minSalaryLpa?: number | null;
  currency?: string;
  skills?: string[];
  keywords?: string[];
  antiKeywords?: string[];
  bio?: string | null;
}

export const userProfileApi = {
  get: () => apiFetch<UserProfile | null>("/user-profile"),
  save: (input: UserProfileInput) =>
    apiFetch<UserProfile>("/user-profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
};

export const JOB_STATUSES = ["new", "saved", "applied", "skipped", "interview", "rejected"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobLead {
  id: string;
  source: string;
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
  postedAt: string | null;
  fetchedAt: string;
  score: number | null;
  scoreReason: string | null;
  classifiedAt: string | null;
  status: JobStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const jobLeadsApi = {
  list: (opts: { status?: JobStatus; minScore?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set("status", opts.status);
    if (opts.minScore != null) q.set("minScore", String(opts.minScore));
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return apiFetch<JobLead[]>(`/job-leads${qs ? "?" + qs : ""}`);
  },
  setStatus: (id: string, status: JobStatus) =>
    apiFetch<{ id: string; status: JobStatus }>(`/job-leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }),
  remove: (id: string) => apiFetch(`/job-leads/${id}`, { method: "DELETE" }),
  startPrep: (id: string) =>
    apiFetch<{ ok: true; workflowId: string }>(`/job-leads/${id}/prep`, { method: "POST" }),
  startTailor: (id: string) =>
    apiFetch<{ ok: true; workflowId: string }>(`/job-leads/${id}/tailor`, { method: "POST" }),
};

// Latest draft (type=brief, source=a2.jobs.draft) via knowledge-items.
export interface JobsDraft {
  id: string;
  title: string;
  body: string | null;
  metadata: { picked?: number | string; minScoreUsed?: number | string; leadIds?: string[] };
  createdAt: string;
  updatedAt: string;
}

export const jobsDigestApi = {
  latest: async (): Promise<JobsDraft | null> => {
    const r = await apiFetch<any[]>(`/knowledge-items?scope=own&type=brief&limit=20`);
    return (r.find((x: any) => x.source === "a2.jobs.draft") as JobsDraft | undefined) ?? null;
  },
};
