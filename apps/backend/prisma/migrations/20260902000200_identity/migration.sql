-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('owner', 'admin', 'manager', 'staff', 'viewer');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "verifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "hash" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "usedAt" TIMESTAMPTZ(6),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "identity_tokens" (
    "hash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),

    CONSTRAINT "identity_tokens_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "TenantRole" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_sessionId_idx" ON "refresh_tokens"("sessionId");

-- CreateIndex
CREATE INDEX "identity_tokens_userId_purpose_idx" ON "identity_tokens"("userId", "purpose");

-- CreateIndex
CREATE INDEX "memberships_userId_idx" ON "memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenantId_userId_key" ON "memberships"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenantId_id_key" ON "memberships"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenantId_id_key" ON "invitations"("tenantId", "id");

-- CreateIndex
CREATE INDEX "audit_events_tenantId_createdAt_idx" ON "audit_events"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_tokens" ADD CONSTRAINT "identity_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


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
 OR EXISTS (SELECT 1 FROM memberships m WHERE m."tenantId"=tenants.id AND m."userId"::text=current_setting('app.actor_id', true) AND m.active)
);
CREATE POLICY tenant_insert ON tenants FOR INSERT TO melissa_runtime WITH CHECK (id::text=current_setting('app.tenant_id', true));
CREATE POLICY tenant_update ON tenants FOR UPDATE TO melissa_runtime USING (id::text=current_setting('app.tenant_id',true)) WITH CHECK (id::text=current_setting('app.tenant_id',true));
CREATE POLICY membership_read ON memberships FOR SELECT TO melissa_runtime USING (
 "tenantId"::text=current_setting('app.tenant_id',true) OR "userId"::text=current_setting('app.actor_id',true)
);
CREATE POLICY membership_insert ON memberships FOR INSERT TO melissa_runtime WITH CHECK ("tenantId"::text=current_setting('app.tenant_id',true));
CREATE POLICY membership_update ON memberships FOR UPDATE TO melissa_runtime USING ("tenantId"::text=current_setting('app.tenant_id',true)) WITH CHECK ("tenantId"::text=current_setting('app.tenant_id',true));
CREATE POLICY invitation_read ON invitations FOR SELECT TO melissa_runtime USING (
 "tenantId"::text=current_setting('app.tenant_id',true) OR "tokenHash"=current_setting('app.invite_hash',true)
);
CREATE POLICY invitation_insert ON invitations FOR INSERT TO melissa_runtime WITH CHECK ("tenantId"::text=current_setting('app.tenant_id',true));
CREATE POLICY invitation_update ON invitations FOR UPDATE TO melissa_runtime USING ("tenantId"::text=current_setting('app.tenant_id',true)) WITH CHECK ("tenantId"::text=current_setting('app.tenant_id',true));
CREATE POLICY audit_read ON audit_events FOR SELECT TO melissa_runtime USING ("tenantId"::text=current_setting('app.tenant_id',true));
CREATE POLICY audit_insert ON audit_events FOR INSERT TO melissa_runtime WITH CHECK ("tenantId"::text=current_setting('app.tenant_id',true));
