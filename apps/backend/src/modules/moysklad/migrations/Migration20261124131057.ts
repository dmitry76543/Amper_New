import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261124131057 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "moysklad_sync_lock" drop constraint if exists "moysklad_sync_lock_key_unique";`);
    this.addSql(`create table if not exists "moysklad_sync_lock" ("id" text not null, "key" text not null, "locked_until" timestamptz null, "lock_token" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "moysklad_sync_lock_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_moysklad_sync_lock_key_unique" ON "moysklad_sync_lock" ("key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_moysklad_sync_lock_deleted_at" ON "moysklad_sync_lock" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "moysklad_sync_lock" cascade;`);
  }

}
