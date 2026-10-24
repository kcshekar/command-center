import { apiFetch } from "./api";

export const SOURCE_KINDS = ["github_release", "dev_to_tag", "rss"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface LearningGoal {
  id: string;
  sourceKind: SourceKind;
  target: string;
  weight: number;
  enabled: boolean;
  note: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LearningGoalInput {
  sourceKind: SourceKind;
  target: string;
  weight?: number;
  enabled?: boolean;
  note?: string | null;
}

export const learningGoalsApi = {
  list: () => apiFetch<LearningGoal[]>("/learning-goals"),
  create: (input: LearningGoalInput) =>
    apiFetch<LearningGoal>("/learning-goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  update: (id: string, input: Partial<LearningGoalInput>) =>
    apiFetch<LearningGoal>(`/learning-goals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  remove: (id: string) => apiFetch(`/learning-goals/${id}`, { method: "DELETE" }),
};

// Lessons + digests are stored in knowledge_items. Reuse the existing
// knowledge-items endpoints we already have (search + list via query params).
export interface Lesson {
  id: string;
  type: string;
  title: string;
  body: string | null;
  tags: string[];
  source: string;
  sourceId: string | null;
  sharedWithOrg: boolean;
  metadata: {
    url?: string; publishedAt?: string; target?: string;
    classification?: { priority: "must" | "skim" | "skip"; rationale?: string };
    classifiedAt?: string;
    mustCount?: number | string; skimCount?: number | string;
    sourceIds?: string[];
    [k: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
}

export const lessonsApi = {
  list: (limit = 100) =>
    apiFetch<Lesson[]>(`/knowledge-items?scope=own&type=lesson&limit=${limit}`),
  latestDigest: async () => {
    const r = await apiFetch<Lesson[]>(`/knowledge-items?scope=own&type=brief&limit=20`);
    return r.find((x) => x.source === "a8.learning.draft") ?? null;
  },
};
