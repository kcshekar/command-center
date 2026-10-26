import { cc } from "../cc-client.js";

// Pgvector embedder — scheduled sweep that picks unembedded knowledge_items,
// calls OpenAI's text-embedding-3-small (1536 dim, matches our column),
// writes back via CC. Per-user BYOK: we fetch the owning user's OpenAI key
// via the credentials integration path.
//
// ponytail: scheduled sweep, swap for fire-after-create when latency matters.
// A sweep means a new knowledge_item is embedded within the next cron tick
// (hourly), good enough for a search-later workflow.

const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = "text-embedding-3-small";
const MAX_INPUT_CHARS = 7000;      // ~2k tokens, well under the model's 8191 cap

interface EmbedResponse {
  data?: Array<{ embedding?: number[] }>;
}

async function openaiEmbed(apiKey: string, input: string): Promise<number[] | null> {
  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: input.slice(0, MAX_INPUT_CHARS) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai ${res.status}: ${body.slice(0, 200)}`);
  }
  const body = (await res.json()) as EmbedResponse;
  const vec = body.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length !== 1536) {
    throw new Error(`openai returned unexpected shape (len=${vec?.length})`);
  }
  return vec;
}

export async function sweepUnembeddedKnowledgeItems(input: {
  limit?: number;
} = {}): Promise<{
  queued: number; embedded: number; skipped: number; failed: number;
  skippedReason?: Record<string, number>;
}> {
  const limit = input.limit ?? 10;
  const items = await cc.listUnembeddedKnowledgeItems(limit);
  if (items.length === 0) return { queued: 0, embedded: 0, skipped: 0, failed: 0 };

  // One OpenAI key cache per user per sweep — avoids N credential lookups
  // when we embed 10 items for the same user.
  const keyCache = new Map<string, string | null>();
  const skippedReason: Record<string, number> = {};
  let embedded = 0, skipped = 0, failed = 0;

  for (const it of items) {
    let apiKey = keyCache.get(it.userId);
    if (apiKey === undefined) {
      try {
        const cred = await cc.getUserCredential(it.userId, "openai");
        apiKey = cred?.key ?? null;
      } catch {
        apiKey = null;
      }
      keyCache.set(it.userId, apiKey);
    }
    if (!apiKey) {
      skipped++;
      skippedReason["no_openai_key"] = (skippedReason["no_openai_key"] ?? 0) + 1;
      continue;
    }

    const text = `${it.title}\n\n${it.body ?? ""}`.trim();
    if (!text) {
      skipped++;
      skippedReason["empty_text"] = (skippedReason["empty_text"] ?? 0) + 1;
      continue;
    }

    try {
      const vec = await openaiEmbed(apiKey, text);
      if (!vec) {
        failed++;
        continue;
      }
      await cc.patchKnowledgeItemEmbedding(it.id, { userId: it.userId, embedding: vec });
      embedded++;
    } catch (err) {
      console.warn("[embedder] failed", { itemId: it.id, err: String(err) });
      failed++;
    }
  }

  return {
    queued: items.length,
    embedded,
    skipped,
    failed,
    skippedReason: Object.keys(skippedReason).length ? skippedReason : undefined,
  };
}
