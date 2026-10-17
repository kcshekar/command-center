-- Legacy mirror table superseded by external_accounts (migration 0020). Code
-- stopped reading it when A1 shipped; dropping now that prod has stabilized.
DROP TABLE IF EXISTS google_oauth_accounts;
