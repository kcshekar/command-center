import { apiFetch } from "./api";

export type ProfileKind = "linkedin" | "readme" | "resume";

export interface ProfileDraft {
  id: string;
  type: string;
  title: string;
  body: string | null;
  tags: string[];
  source: string;
  sourceId: string | null;
  sharedWithOrg: boolean;
  metadata: { kind?: ProfileKind; [k: string]: unknown };
  createdAt: string;
  updatedAt: string;
}

export const profileDraftsApi = {
  // Pull all A7 drafts (newest first) and let the UI pick the latest of
  // each kind. Also returns the raw list so the UI can show history too.
  listA7: () =>
    apiFetch<ProfileDraft[]>(`/knowledge-items?scope=own&type=profile&limit=50`),

  // Users edit the stored draft directly — same PATCH endpoint knowledge-items
  // already exposes.
  updateBody: (id: string, body: string) =>
    apiFetch<ProfileDraft>(`/knowledge-items/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }),

  // A7 — kick off the workflow that commits this draft into a GitHub repo
  // on a fresh branch and opens a PR. Repo is "owner/repo" (e.g. "chandu/chandu").
  openPR: (id: string, repo: string, path?: string) =>
    apiFetch<{ ok: boolean; workflowId: string }>(`/knowledge-items/${id}/open-pr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, path }),
    }),
};
