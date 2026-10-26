import { getGithubCredentialByCcUser, gh } from "../github-oauth.js";
import { cc } from "../cc-client.js";

// A7 — commit a knowledge_item body (e.g. the latest A7 README draft) into
// a GitHub repo as a new branch + PR. The user chooses the target repo at
// trigger time (e.g. "chandu/chandu" for a profile README).
//
// Flow:
//   1. Resolve the user's GitHub OAuth creds by CC user id
//   2. Fetch the repo's default_branch + its latest commit SHA
//   3. Create a new branch "a7/<path>-<yyyymmddHHmm>"
//   4. GET the current file (if it exists) to get its SHA for update
//   5. PUT the file (base64 body) on the new branch — commits in one call
//   6. POST a PR from the new branch → default_branch
//
// All GitHub errors bubble to the workflow which retries once; no partial
// state cleanup — a dangling branch is cheap to delete manually.

interface GhUser { login: string; }
interface GhRepo { default_branch: string; }
interface GhRef { object: { sha: string }; }
interface GhContent { sha: string; }
interface GhPR { html_url: string; number: number; }

function parseRepo(fullName: string): { owner: string; repo: string } | null {
  const m = fullName.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
function stampBranch(path: string): string {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,"0")}${String(now.getUTCDate()).padStart(2,"0")}${String(now.getUTCHours()).padStart(2,"0")}${String(now.getUTCMinutes()).padStart(2,"0")}`;
  const slug = path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 40);
  return `a7/${slug || "update"}-${stamp}`;
}

export async function openGithubPrFromKnowledgeItem(input: {
  userId: string;
  knowledgeItemId: string;
  repo: string;                 // "owner/repo"
  path?: string;                // default: "README.md"
  branchName?: string;
  prTitle?: string;
  prBody?: string;
  commitMessage?: string;
}): Promise<{
  status: "ok" | "no_github" | "no_item" | "no_body" | "invalid_repo" | "pr_failed";
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  reason?: string;
}> {
  const repoRef = parseRepo(input.repo);
  if (!repoRef) return { status: "invalid_repo", reason: "expected 'owner/repo'" };

  const cred = await getGithubCredentialByCcUser(input.userId);
  if (!cred) return { status: "no_github", reason: "user has not connected GitHub" };

  const draft = await cc.getKnowledgeItemFull(input.knowledgeItemId, input.userId).catch(() => null);
  if (!draft) return { status: "no_item", reason: "knowledge item not found" };
  const body = draft.body;
  if (!body || !body.trim()) return { status: "no_body", reason: "knowledge item has no body" };

  const path = input.path ?? "README.md";
  const branch = input.branchName ?? stampBranch(path);
  const token = cred.accessToken;

  // 1. default_branch + its latest commit sha
  const repoMeta = await gh<GhRepo>(token, `/repos/${repoRef.owner}/${repoRef.repo}`);
  const defaultBranch = repoMeta.default_branch;
  const defaultRef = await gh<GhRef>(token, `/repos/${repoRef.owner}/${repoRef.repo}/git/ref/heads/${defaultBranch}`);
  const baseSha = defaultRef.object.sha;

  // 2. Create the new branch
  await gh(token, `/repos/${repoRef.owner}/${repoRef.repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });

  // 3. Fetch existing file sha if present (so PUT can update instead of fail)
  let existingSha: string | undefined;
  try {
    const existing = await gh<GhContent>(token, `/repos/${repoRef.owner}/${repoRef.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
    existingSha = existing.sha;
  } catch { /* 404 → file doesn't exist on this branch; create it */ }

  // 4. PUT the file (base64 content). This commits on the new branch.
  const encodedContent = Buffer.from(body, "utf8").toString("base64");
  const commitMessage = input.commitMessage ?? `A7: refresh ${path}`;
  await gh(token, `/repos/${repoRef.owner}/${repoRef.repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: commitMessage,
      content: encodedContent,
      branch,
      sha: existingSha,
    }),
  });

  // 5. Open PR
  try {
    const pr = await gh<GhPR>(token, `/repos/${repoRef.owner}/${repoRef.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({
        title: input.prTitle ?? `A7: refresh ${path} (${new Date().toISOString().slice(0,10)})`,
        head: branch,
        base: defaultBranch,
        body: input.prBody ?? `Automated refresh via A7 (Monthly Profile Refresh). Review the diff before merging.`,
      }),
    });
    // Fire an SSE event so the UI toast lands on completion.
    try {
      await cc.emitEvent({
        userId: input.userId,
        type: "github_pr:opened",
        payload: { repo: input.repo, path, prUrl: pr.html_url, prNumber: pr.number },
      });
    } catch { /* best-effort */ }
    return { status: "ok", prUrl: pr.html_url, prNumber: pr.number, branch };
  } catch (err) {
    return { status: "pr_failed", branch, reason: String(err).slice(0, 200) };
  }
}
