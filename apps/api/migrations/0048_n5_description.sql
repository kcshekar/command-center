-- N5 no longer uses an LLM line (llama3.2:3b added unsupported judgements next
-- to exact figures); the closing line is computed. Keep the catalog honest.
UPDATE automation_catalog
   SET description = 'Every evening at 21:00: today''s personal spending by category, and which categories ran above 2x their usual day (needs at least 3 days of history). Computed only, no AI text; nothing leaves your machine.'
 WHERE id = 'n5.spend';
