import { apiFetch } from "./api";

export interface CommandSummary {
  id: string;
  title: string;
  command_text: string;
  context: string | null;
  notes: string | null;
  created_by: string;
  updated_at: string;
}
export interface Comment {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
}
export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number | null;
  uploadedBy: string;
  uploadedAt: string;
  downloadUrl?: string;
}
// Command detail is `SELECT *` server-side (snake_case) merged with camelCase arrays.
export interface CommandDetail {
  id: string;
  org_id: string;
  title: string;
  command_text: string;
  context: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  comments: Comment[];
  attachments: Attachment[];
}

export const kbApi = {
  list: (context?: string) => apiFetch<CommandSummary[]>(`/kb/commands${context ? `?context=${encodeURIComponent(context)}` : ""}`),
  get: (commandId: string) => apiFetch<CommandDetail>(`/kb/commands/${commandId}`),
  create: (params: { title: string; commandText: string; context?: string; notes?: string }) =>
    apiFetch<{ id: string }>("/kb/commands", { method: "POST", body: JSON.stringify(params) }),
  update: (commandId: string, params: { title: string; commandText: string; context?: string; notes?: string }) =>
    apiFetch(`/kb/commands/${commandId}`, { method: "PUT", body: JSON.stringify(params) }),
  remove: (commandId: string) => apiFetch(`/kb/commands/${commandId}`, { method: "DELETE" }),
  addComment: (commandId: string, body: string) =>
    apiFetch<Comment>(`/kb/commands/${commandId}/comments`, { method: "POST", body: JSON.stringify({ body }) }),

  presignUpload: (params: { resourceType: string; resourceId: string; filename: string; contentType: string }) =>
    apiFetch<{ uploadUrl: string; objectKey: string }>("/kb/attachments/presign", { method: "POST", body: JSON.stringify(params) }),
  confirmUpload: (params: { resourceType: string; resourceId: string; objectKey: string; filename: string; contentType: string; sizeBytes: number }) =>
    apiFetch("/kb/attachments/confirm", { method: "POST", body: JSON.stringify(params) }),
  listAttachments: (resourceType: string, resourceId: string) =>
    apiFetch<Attachment[]>(`/kb/attachments?resourceType=${resourceType}&resourceId=${resourceId}`),
  deleteAttachment: (attachmentId: string) => apiFetch(`/kb/attachments/${attachmentId}`, { method: "DELETE" }),
};

// Uploads a file directly to storage via a pre-signed URL — the API server
// never sees the binary. confirmUpload persists the metadata afterward.
export async function uploadFile(resourceType: string, resourceId: string, file: File): Promise<void> {
  const { uploadUrl, objectKey } = await kbApi.presignUpload({
    resourceType,
    resourceId,
    filename: file.name,
    contentType: file.type || "application/octet-stream",
  });
  const putRes = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
  if (!putRes.ok) throw new Error("Upload to storage failed");
  await kbApi.confirmUpload({
    resourceType,
    resourceId,
    objectKey,
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    sizeBytes: file.size,
  });
}
