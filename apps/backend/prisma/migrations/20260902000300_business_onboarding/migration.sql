ALTER TABLE tenants
  ADD COLUMN legal_name TEXT,
  ADD COLUMN industry_key TEXT,
  ADD COLUMN city TEXT,
  ADD COLUMN address TEXT,
  ADD COLUMN website TEXT,
  ADD COLUMN locale TEXT NOT NULL DEFAULT 'pt',
  ADD COLUMN currency TEXT NOT NULL DEFAULT 'EUR',
  ADD COLUMN onboarding_step INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN provisioning_status TEXT NOT NULL DEFAULT 'configuring';

CREATE TABLE industry_templates (
 id UUID PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 description TEXT NOT NULL, defaults JSONB NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ(6) NOT NULL
);
CREATE TABLE services (
 id UUID NOT NULL, tenant_id UUID NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
 description TEXT, category TEXT, price DECIMAL(20,6) NOT NULL, currency TEXT NOT NULL,
 duration_minutes INTEGER NOT NULL, buffer_before_minutes INTEGER NOT NULL DEFAULT 0,
 buffer_after_minutes INTEGER NOT NULL DEFAULT 0, booking_enabled BOOLEAN NOT NULL DEFAULT true,
 active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ(6) NOT NULL, deleted_at TIMESTAMPTZ(6),
 PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,slug),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
CREATE TABLE business_hours (
 id UUID NOT NULL, tenant_id UUID NOT NULL, weekday INTEGER NOT NULL,
 start_time TEXT NOT NULL, end_time TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
 PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CHECK (weekday BETWEEN 1 AND 7), CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 CHECK (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'), CHECK (start_time < end_time)
);
CREATE INDEX business_hours_tenant_weekday_idx ON business_hours(tenant_id,weekday);
CREATE TABLE schedule_exceptions (
 id UUID NOT NULL, tenant_id UUID NOT NULL, date DATE NOT NULL, start_time TEXT, end_time TEXT,
 closed BOOLEAN NOT NULL DEFAULT false, reason TEXT,
 PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CHECK ((closed AND start_time IS NULL AND end_time IS NULL) OR
        (NOT closed AND start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         AND end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND start_time < end_time))
);
CREATE INDEX schedule_exceptions_tenant_date_idx ON schedule_exceptions(tenant_id,date);
CREATE TABLE faqs (
 id UUID NOT NULL, tenant_id UUID NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
 category TEXT, active BOOLEAN NOT NULL DEFAULT true,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ(6) NOT NULL,
 PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
CREATE TABLE staff (
 id UUID NOT NULL, tenant_id UUID NOT NULL, user_id UUID, name TEXT NOT NULL, email TEXT,
 phone TEXT, avatar_url TEXT, role_title TEXT, active BOOLEAN NOT NULL DEFAULT true,
 timezone TEXT NOT NULL, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ(6) NOT NULL,
 PRIMARY KEY (tenant_id,id), FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
);
CREATE TABLE staff_services (
 tenant_id UUID NOT NULL, staff_id UUID NOT NULL, service_id UUID NOT NULL,
 custom_duration_minutes INTEGER, custom_price DECIMAL(20,6), active BOOLEAN NOT NULL DEFAULT true,
 PRIMARY KEY (tenant_id,staff_id,service_id),
 FOREIGN KEY (tenant_id,staff_id) REFERENCES staff(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY (tenant_id,service_id) REFERENCES services(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE tenant_configurations (
 tenant_id UUID PRIMARY KEY, cancellation TEXT, rescheduling TEXT, lateness TEXT, no_show TEXT,
 payment TEXT, refunds TEXT, deposits TEXT, minimum_age INTEGER, other_rules TEXT,
 tone TEXT NOT NULL DEFAULT 'friendly', use_emojis BOOLEAN NOT NULL DEFAULT false,
 use_customer_name BOOLEAN NOT NULL DEFAULT true,
 reply_in_customer_language BOOLEAN NOT NULL DEFAULT true,
 verbosity TEXT NOT NULL DEFAULT 'normal', updated_at TIMESTAMPTZ(6) NOT NULL,
 FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
 CHECK (tone IN ('professional','friendly','informal','premium','concise')),
 CHECK (verbosity IN ('short','normal','detailed'))
);

INSERT INTO industry_templates(id,key,name,description,defaults,updated_at)
SELECT gen_random_uuid(), key, name, description, '{}'::jsonb, CURRENT_TIMESTAMP FROM (VALUES
 ('barbershop','Barbershop','Barbershops and grooming'),
 ('hair_salon','Hair salon','Hair salons'),
 ('beauty_salon','Beauty salon','Beauty services'),
 ('spa','Spa','Spa and wellness'), ('garage','Garage','Vehicle services'),
 ('real_estate','Real estate','Property businesses'), ('gym','Gym','Fitness centres'),
 ('personal_trainer','Personal trainer','Personal training'),
 ('restaurant','Restaurant','Restaurants'), ('home_services','Home services','Home services'),
 ('consulting','Consulting','Professional consulting'), ('generic','Other','Generic business')
) AS t(key,name,description);

GRANT SELECT ON industry_templates TO melissa_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON services,business_hours,schedule_exceptions,faqs,staff,staff_services,tenant_configurations TO melissa_runtime;
GRANT UPDATE (legal_name,industry_key,city,address,website,locale,currency,onboarding_step,provisioning_status) ON tenants TO melissa_runtime;

ALTER TABLE services ENABLE ROW LEVEL SECURITY; ALTER TABLE services FORCE ROW LEVEL SECURITY;
ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY; ALTER TABLE business_hours FORCE ROW LEVEL SECURITY;
ALTER TABLE schedule_exceptions ENABLE ROW LEVEL SECURITY; ALTER TABLE schedule_exceptions FORCE ROW LEVEL SECURITY;
ALTER TABLE faqs ENABLE ROW LEVEL SECURITY; ALTER TABLE faqs FORCE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY; ALTER TABLE staff FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_services ENABLE ROW LEVEL SECURITY; ALTER TABLE staff_services FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_configurations ENABLE ROW LEVEL SECURITY; ALTER TABLE tenant_configurations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_scope ON services TO melissa_runtime USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY tenant_scope ON business_hours TO melissa_runtime USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY tenant_scope ON schedule_exceptions TO melissa_runtime USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY tenant_scope ON faqs TO melissa_runtime USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY tenant_scope ON staff TO melissa_runtime USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY tenant_scope ON staff_services TO melissa_runtime USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY tenant_scope ON tenant_configurations TO melissa_runtime USING (tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));

UPDATE infrastructure_metadata SET value='3' WHERE key='schema_version';
