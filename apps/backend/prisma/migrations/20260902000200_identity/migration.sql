-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('owner', 'admin', 'manager', 'staff', 'viewer');

-- CreateTable
CREATE TABLE "users" (
    "terms_version" TEXT NOT NULL,
    "terms_accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "hash" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "identity_tokens" (
    "hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "identity_tokens_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TenantRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "identity_tokens_user_id_purpose_idx" ON "identity_tokens"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_user_id_key" ON "memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_id_key" ON "memberships"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenant_id_id_key" ON "invitations"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_created_at_idx" ON "audit_events"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_tokens" ADD CONSTRAINT "identity_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Application role is provisioned separately from the migration owner.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO melissa_runtime;
GRANT SELECT ON infrastructure_metadata TO melissa_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions, refresh_tokens, identity_tokens TO melissa_runtime;
GRANT SELECT, INSERT, UPDATE ON tenants, memberships, invitations TO melissa_runtime;
GRANT SELECT, INSERT ON audit_events TO melissa_runtime;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON tenants FOR SELECT TO melissa_runtime USING (
 id::text = current_setting('app.tenant_id', true)
 OR EXISTS (SELECT 1 FROM memberships m WHERE m."tenant_id"=tenants.id AND m."user_id"::text=current_setting('app.actor_id', true) AND m.active)
);
CREATE POLICY tenant_insert ON tenants FOR INSERT TO melissa_runtime WITH CHECK (id::text=current_setting('app.tenant_id', true));
CREATE POLICY tenant_update ON tenants FOR UPDATE TO melissa_runtime USING (id::text=current_setting('app.tenant_id',true)) WITH CHECK (id::text=current_setting('app.tenant_id',true));
CREATE POLICY membership_read ON memberships FOR SELECT TO melissa_runtime USING (
 "tenant_id"::text=current_setting('app.tenant_id',true) OR "user_id"::text=current_setting('app.actor_id',true)
);
CREATE POLICY membership_insert ON memberships FOR INSERT TO melissa_runtime WITH CHECK ("tenant_id"::text=current_setting('app.tenant_id',true));
CREATE POLICY membership_update ON memberships FOR UPDATE TO melissa_runtime USING ("tenant_id"::text=current_setting('app.tenant_id',true)) WITH CHECK ("tenant_id"::text=current_setting('app.tenant_id',true));
CREATE POLICY invitation_read ON invitations FOR SELECT TO melissa_runtime USING (
 "tenant_id"::text=current_setting('app.tenant_id',true) OR "token_hash"=current_setting('app.invite_hash',true)
);
CREATE POLICY invitation_insert ON invitations FOR INSERT TO melissa_runtime WITH CHECK ("tenant_id"::text=current_setting('app.tenant_id',true));
CREATE POLICY invitation_update ON invitations FOR UPDATE TO melissa_runtime USING ("tenant_id"::text=current_setting('app.tenant_id',true)) WITH CHECK ("tenant_id"::text=current_setting('app.tenant_id',true));
CREATE POLICY audit_read ON audit_events FOR SELECT TO melissa_runtime USING ("tenant_id"::text=current_setting('app.tenant_id',true));
CREATE POLICY audit_insert ON audit_events FOR INSERT TO melissa_runtime WITH CHECK ("tenant_id"::text=current_setting('app.tenant_id',true));

UPDATE infrastructure_metadata SET value='2' WHERE key='schema_version';
