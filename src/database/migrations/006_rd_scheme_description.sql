-- 006_rd_scheme_description
-- The RD service (SCHEME_SELECT, listSchemes, createScheme), its SchemeView
-- contract and the admin scheme catalogue all expose a scheme `description`,
-- but 001_schema.sql never created that column on rd_scheme. Add it so the
-- GET /api/v1/rd/schemes catalogue no longer fails with
-- "column \"description\" does not exist" (SQLSTATE 42703).

ALTER TABLE rd_scheme
  ADD COLUMN IF NOT EXISTS description TEXT;

COMMENT ON COLUMN rd_scheme.description IS
  'Optional operator-facing description of the recurring deposit scheme.';
