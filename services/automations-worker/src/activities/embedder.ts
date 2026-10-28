import { cc } from "../cc-client.js";
import { ollamaEmbed } from "../ollama.js";

// Pgvector embedder — scheduled sweep that picks unembedded knowledge_items,
// embeds them on the LOCAL Ollama (nomic-embed-text, 768-dim; P2.0), and
// writes back via CC. Nothing leaves the box and no per-user key is needed.
//
// ponytail: scheduled sweep, swap for fire-after-create when latency matters.
// A sweep means a new knowledge_item is embedded within the next cron tick
// (hourly), good enough for a search-later workflow.

const MAX_INPUT_CHARS = 6000;      // ~1.5k tokens, inside nomic's 2048-token default context

export async function sweepUnembeddedKnowledgeItems(input: {
  limit?: number;
} = {}): Promise<{
  queued: number; embedded: number; skipped: number; failed: number;
}> {
  const limit = input.limit ?? 10;
  const items = await cc.listUnembeddedKnowledgeItems(limit);
  if (items.length === 0) return { queued: 0, embedded: 0, skipped: 0, failed: 0 };

  const todo = items
    .map((it) => ({ it, text: `${it.title}\n\n${it.body ?? ""}`.trim().slice(0, MAX_INPUT_CHARS) }))
    .filter((x) => x.text);
  // One batched call; an Ollama failure throws so Temporal retries the sweep.
  const vectors = await ollamaEmbed(todo.map((x) => x.text), "document");

  let embedded = 0, failed = 0;
  for (const [i, { it }] of todo.entries()) {
    try {
      await cc.patchKnowledgeItemEmbedding(it.id, { userId: it.userId, embedding: vectors[i] });
      embedded++;
    } catch (err) {
      console.warn("[embedder] write-back failed", { itemId: it.id, err: String(err) });
      failed++;
    }
  }
  return { queued: items.length, embedded, skipped: items.length - todo.length, failed };
}
