-- ProviderProxy in an existing Supabase project (or any Postgres): an isolated login that owns one schema and
-- can touch nothing else. Run once in the Supabase SQL editor (as `postgres`). It changes nothing outside the new
-- role and schema.
--
-- 1. Pick a strong password (letters + digits avoid URL encoding) and put it below, or better: pass a SCRAM
--    verifier ('SCRAM-SHA-256$4096:...') so the plain password never appears in the query logs.
-- 2. Run the script.
-- 3. Connection strings (session pooler, IPv4; copy the exact host from the dashboard's Connect dialog):
--      DATABASE_URL = postgresql://provider_proxy.<project-ref>:<password>@aws-N-<region>.pooler.supabase.com:5432/postgres?schema=provider_proxy
--      DIRECT_URL   = the same + &sslmode=require      (migrations)
--      DATABASE_CA_CERT = the project's CA certificate (Database settings > SSL Configuration)

create role provider_proxy with login password 'CHANGE-ME' connection limit 20;

-- a bug or a heavy report in the proxy can never hold locks or connections for long
alter role provider_proxy set search_path = provider_proxy;
alter role provider_proxy set statement_timeout = '60s';
alter role provider_proxy set idle_in_transaction_session_timeout = '60s';
alter role provider_proxy set lock_timeout = '10s';

-- Postgres 16+: the creator must be able to act as the role to give it a schema
grant provider_proxy to postgres;
create schema provider_proxy authorization provider_proxy;
revoke all on schema provider_proxy from public;

-- The role gets no grant anywhere else: tables in `public`, `auth`, `storage` ... stay out of its reach, and the
-- schema is not exposed through the Data API (only the schemas listed in API settings are).
--
-- Undo (drops every ProviderProxy table):
--   drop schema provider_proxy cascade; drop role provider_proxy;
