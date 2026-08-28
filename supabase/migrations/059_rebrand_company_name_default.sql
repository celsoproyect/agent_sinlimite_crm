-- Rebrand the platform_settings.company_name column default away from
-- the upstream "wacrm" template name. Existing rows are not touched
-- here: if the live platform_settings row already has the literal
-- value 'wacrm', update it separately (e.g. via the super-admin
-- branding UI) since this migration only changes the default applied
-- to future inserts.
ALTER TABLE platform_settings
  ALTER COLUMN company_name SET DEFAULT 'Sin Limite IA';
