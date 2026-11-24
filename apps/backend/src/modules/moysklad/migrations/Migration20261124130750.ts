import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261124130750 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "moysklad_order_outbox" drop constraint if exists "moysklad_order_outbox_order_id_unique";`);
    this.addSql(`create table if not exists "moysklad_order_outbox" ("id" text not null, "order_id" text not null, "status" text check ("status" in ('pending', 'processing', 'retry', 'completed', 'failed')) not null default 'pending', "attempts" integer not null default 0, "next_attempt_at" timestamptz null, "locked_at" timestamptz null, "last_error" text null, "moysklad_order_id" text null, "moysklad_order_name" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "moysklad_order_outbox_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_moysklad_order_outbox_order_id_unique" ON "moysklad_order_outbox" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_moysklad_order_outbox_deleted_at" ON "moysklad_order_outbox" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "moysklad_order_outbox" cascade;`);
  }

}
