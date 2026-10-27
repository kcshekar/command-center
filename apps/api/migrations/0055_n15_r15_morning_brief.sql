-- N15 (weather + air quality) and R15 (one-line affirmation) are sections of
-- the morning brief, not separate schedules. The brief needs the user id to
-- read the OpenWeatherMap BYOK key and the profile location; existing a0.brief
-- schedules pick this up the next time they're turned on or their accounts saved.
UPDATE automation_catalog
   SET schedule_template = jsonb_set(schedule_template, '{args,userId}', '"$userId"'),
       description = 'Daily 07:30 digest: today''s calendar, open Google Tasks, reminders due this week, weather and air quality (with an OpenWeatherMap key and your city set), and a one-line note for the day.'
 WHERE id = 'a0.brief';
