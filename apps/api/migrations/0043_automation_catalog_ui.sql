-- U2: the catalog becomes the single source for where an automation shows up
-- in the web shell. A new automation gets a sidebar entry, an Automations hub
-- card and a command-palette item by inserting one row — no web code edits.
--
--   area      which sidebar group it belongs to (money|career|knowledge|life|mail|platform)
--   ui_route  the page that hosts its UI; NULL = no page of its own (runs in the background)
--   ui_label  sidebar label for that page (one row per page carries it)
--   icon      lucide icon name; the web maps a small known set, unknown → default

ALTER TABLE automation_catalog
  ADD COLUMN area     text NOT NULL DEFAULT 'platform'
    CHECK (area IN ('money','career','knowledge','life','mail','platform')),
  ADD COLUMN ui_route text,
  ADD COLUMN ui_label text,
  ADD COLUMN icon     text;

UPDATE automation_catalog SET area = 'career',    ui_route = '/jobs',           ui_label = 'Jobs',           icon = 'briefcase'      WHERE id = 'a2.jobs';
UPDATE automation_catalog SET area = 'career',    ui_route = '/interviews',     ui_label = 'Interviews',     icon = 'message-square' WHERE id = 'a4.tracker';
UPDATE automation_catalog SET area = 'career',    ui_route = '/profile-drafts', ui_label = 'Profile Drafts', icon = 'user-circle'    WHERE id = 'a7.profile';
UPDATE automation_catalog SET area = 'career'                                                                                   WHERE id IN ('a1.news', 'a3.prep', 'a9.resume');
UPDATE automation_catalog SET area = 'knowledge', ui_route = '/learning',       ui_label = 'Learning',       icon = 'graduation-cap' WHERE id = 'a8.learning';
UPDATE automation_catalog SET area = 'life',      ui_route = '/price-watcher',  ui_label = 'Price Watcher',  icon = 'tag'            WHERE id = 'a6.price';
UPDATE automation_catalog SET area = 'life',      ui_route = '/pilgrim',        ui_label = 'TTD / Pilgrim',  icon = 'users'          WHERE id = 'a10.ttd';
UPDATE automation_catalog SET area = 'mail'                                                                                     WHERE id IN ('a5.mail', 'a5.reply');
-- a11.upgrader stays 'platform' with no page.
