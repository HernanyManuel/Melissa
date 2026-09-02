CREATE TABLE "infrastructure_metadata" (
  "key" TEXT PRIMARY KEY,
  "value" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "infrastructure_metadata" ("key", "value") VALUES ('schema_version', '1');
