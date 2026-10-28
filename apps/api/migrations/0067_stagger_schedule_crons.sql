-- P0.3: stagger automation crons so they don't all hit the worker (and the one
-- local Ollama model) on the same minute. Frequent schedules move off the
-- :00/:30 grid; same-slot daily/weekly ones are spread 5 min apart.
-- Guarded on the old cron so a hand-edited template is left alone.
-- Existing Temporal schedules keep their old spec until resynced:
--   bun --env-file=.env apps/api/scripts/resync-schedule-crons.ts
UPDATE automation_catalog c
   SET schedule_template = jsonb_set(c.schedule_template::jsonb, '{cron}', to_jsonb(v.new_cron)),
       cadence_default   = 'cron:' || v.new_cron,
       updated_at        = now()
  FROM (VALUES
    ('a5.mail',       '*/15 * * * *', '2-59/15 * * * *'),
    ('n13.meetings',  '*/30 * * * *', '8-59/30 * * * *'),
    ('a4.tracker',    '0 * * * *',    '23 * * * *'),
    ('r14.travel',    '0 * * * *',    '53 * * * *'),
    ('a8.learning',   '0 8 * * 1',    '5 8 * * 1'),
    ('r12.networth',  '0 8 1 * *',    '10 8 1 * *'),
    ('r7.groceries',  '0 8 * * 6',    '15 8 * * 6'),
    ('r2.docs',       '0 9 * * *',    '5 9 * * *'),
    ('r9.vehicle',    '0 9 * * 1',    '10 9 * * 1'),
    ('a1.news',       '0 9 * * 1,4',  '15 9 * * 1,4'),
    ('a2.jobs',       '0 9,18 * * *', '20 9,18 * * *'),
    ('a7.profile',    '0 10 1 * *',   '5 10 1 * *'),
    ('n12.ca',        '0 10 5 * *',   '10 10 5 * *'),
    ('r10.budget',    '0 20 * * 5',   '5 20 * * 5'),
    ('r11.habits',    '0 21 * * *',   '5 21 * * *')
  ) AS v(id, old_cron, new_cron)
 WHERE c.id = v.id
   AND c.schedule_template->>'cron' = v.old_cron;
