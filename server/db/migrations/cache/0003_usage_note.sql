-- Remember why a provider was stopped for the day (the provider's own message), so Settings can show it.
ALTER TABLE api_usage ADD COLUMN note TEXT;
