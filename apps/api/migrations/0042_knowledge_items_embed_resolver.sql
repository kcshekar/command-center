-- Phase 1.5 follow-up — cross-user unembedded knowledge_item scanner for the
-- worker's batch embedder. SECURITY DEFINER so one service-token call sees
-- every user's rows in the token's org (per-user RLS otherwise hides them).
--
-- Narrow projection: id, user_id, and the text we need to embed. No metadata,
-- no body echo back to CC beyond what the worker will feed OpenAI.

CREATE OR REPLACE FUNCTION list_unembedded_knowledge_items(p_org_id uuid, p_limit int)
RETURNS TABLE (
  id        uuid,
  user_id   uuid,
  title     text,
  body      text,
  type      text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, user_id, title, body, type
  FROM knowledge_items
  WHERE embedding IS NULL
    AND org_id = p_org_id
    -- Must have at least a title (body may legitimately be null for some types)
    AND title IS NOT NULL AND length(title) > 0
  ORDER BY created_at DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION list_unembedded_knowledge_items(uuid, int) TO command_center_app;
