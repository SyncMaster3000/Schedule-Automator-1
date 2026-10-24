CREATE TABLE "groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_id" integer NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" integer NOT NULL,
	"name" text,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"time_grid" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"day_grids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"excluded_dates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_grid_fill_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"work_week" text DEFAULT 'mon-fri' NOT NULL,
	"empty_slot_mode" text DEFAULT 'empty' NOT NULL,
	"group_mode" boolean DEFAULT false NOT NULL,
	"separate_lectures" boolean DEFAULT false NOT NULL,
	CONSTRAINT "periods_organization_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "program_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" integer NOT NULL,
	"utp_number" text NOT NULL,
	"title" text NOT NULL,
	"discipline_name" text,
	"utp_source" text,
	"utp_name" text,
	"utp_source_file" text,
	"total_hours" double precision DEFAULT 0 NOT NULL,
	"lecture_hours" double precision DEFAULT 0 NOT NULL,
	"practice_hours" double precision DEFAULT 0 NOT NULL,
	"roundtable_hours" double precision DEFAULT 0 NOT NULL,
	"default_dept" text,
	"default_lesson_type" text,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"assigned_period_id" integer,
	"scheduled_hours" double precision DEFAULT 0 NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL,
	"is_section" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "program_topics_organization_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"approver_name" text,
	"approver_title" text,
	"approve_date" date,
	"signer_name" text,
	"signer_title" text,
	"sign_date" date,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programs_organization_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"type" text,
	CONSTRAINT "rooms_organization_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "schedule_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" integer,
	"period_id" integer,
	"action" text NOT NULL,
	"details" jsonb,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_id" integer NOT NULL,
	"program_id" integer NOT NULL,
	"topic_id" integer,
	"date" date NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"start_dt" text NOT NULL,
	"end_dt" text NOT NULL,
	"lesson_type" text,
	"custom_title" text,
	"teacher_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_teachers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"room_id" integer,
	"group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"group_label" text,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"is_outside_period" boolean DEFAULT false NOT NULL,
	"is_modified" boolean DEFAULT false NOT NULL,
	"modified_at" timestamp with time zone,
	"change_desc" text,
	"grid_fill_id" text,
	"grid_fill_signature" text,
	CONSTRAINT "schedule_items_organization_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
CREATE TABLE "schedule_locks" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"schedule_item_id" integer NOT NULL,
	"period_id" integer NOT NULL,
	"program_id" integer NOT NULL,
	"resource_id" integer NOT NULL,
	"resource_type" text NOT NULL,
	"start_dt" text NOT NULL,
	"end_dt" text NOT NULL,
	"topic_id" integer
);
--> statement-breakpoint
CREATE TABLE "schedule_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" integer NOT NULL,
	"period_id" integer,
	"text" text NOT NULL,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_temp_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"period_id" integer NOT NULL,
	"source_item_id" integer,
	"valid_from" date NOT NULL,
	"valid_until" date NOT NULL,
	"reason" text,
	"is_cancelled" boolean DEFAULT false NOT NULL,
	"date" date,
	"start_time" text,
	"end_time" text,
	"topic_id" integer,
	"custom_title" text,
	"lesson_type" text,
	"teacher_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_teachers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"room_id" integer,
	"group_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"group_label" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"program_id" integer,
	"program_title" text DEFAULT '' NOT NULL,
	"version_label" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"note" text,
	"archive_section" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teachers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"fio" text NOT NULL,
	"department" text,
	"is_guest" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_grids" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_slots" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"start" text NOT NULL,
	"end" text NOT NULL,
	"is_break" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organization_period_fk" FOREIGN KEY ("organization_id","period_id") REFERENCES "public"."periods"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periods" ADD CONSTRAINT "periods_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "periods" ADD CONSTRAINT "periods_organization_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "public"."programs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_topics" ADD CONSTRAINT "program_topics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_topics" ADD CONSTRAINT "program_topics_organization_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "public"."programs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_topics" ADD CONSTRAINT "program_topics_organization_assigned_period_fk" FOREIGN KEY ("organization_id","assigned_period_id") REFERENCES "public"."periods"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_audit" ADD CONSTRAINT "schedule_audit_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_organization_period_fk" FOREIGN KEY ("organization_id","period_id") REFERENCES "public"."periods"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_organization_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "public"."programs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_organization_topic_fk" FOREIGN KEY ("organization_id","topic_id") REFERENCES "public"."program_topics"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_organization_room_fk" FOREIGN KEY ("organization_id","room_id") REFERENCES "public"."rooms"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_locks" ADD CONSTRAINT "schedule_locks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_locks" ADD CONSTRAINT "schedule_locks_organization_item_fk" FOREIGN KEY ("organization_id","schedule_item_id") REFERENCES "public"."schedule_items"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_locks" ADD CONSTRAINT "schedule_locks_organization_period_fk" FOREIGN KEY ("organization_id","period_id") REFERENCES "public"."periods"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_locks" ADD CONSTRAINT "schedule_locks_organization_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "public"."programs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_notes" ADD CONSTRAINT "schedule_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_notes" ADD CONSTRAINT "schedule_notes_organization_program_fk" FOREIGN KEY ("organization_id","program_id") REFERENCES "public"."programs"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_temp_items" ADD CONSTRAINT "schedule_temp_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_temp_items" ADD CONSTRAINT "schedule_temp_items_organization_period_fk" FOREIGN KEY ("organization_id","period_id") REFERENCES "public"."periods"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_temp_items" ADD CONSTRAINT "schedule_temp_items_organization_source_item_fk" FOREIGN KEY ("organization_id","source_item_id") REFERENCES "public"."schedule_items"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_temp_items" ADD CONSTRAINT "schedule_temp_items_organization_topic_fk" FOREIGN KEY ("organization_id","topic_id") REFERENCES "public"."program_topics"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_temp_items" ADD CONSTRAINT "schedule_temp_items_organization_room_fk" FOREIGN KEY ("organization_id","room_id") REFERENCES "public"."rooms"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_versions" ADD CONSTRAINT "schedule_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teachers" ADD CONSTRAINT "teachers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_grids" ADD CONSTRAINT "time_grids_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_slots" ADD CONSTRAINT "time_slots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "groups_organization_id_uq" ON "groups" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "groups_organization_period_idx" ON "groups" USING btree ("organization_id","period_id");--> statement-breakpoint
CREATE INDEX "periods_organization_program_idx" ON "periods" USING btree ("organization_id","program_id");--> statement-breakpoint
CREATE INDEX "program_topics_organization_program_number_idx" ON "program_topics" USING btree ("organization_id","program_id","utp_number");--> statement-breakpoint
CREATE INDEX "programs_organization_updated_idx" ON "programs" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "rooms_organization_number_idx" ON "rooms" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "schedule_audit_organization_time_idx" ON "schedule_audit" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "schedule_items_organization_period_date_idx" ON "schedule_items" USING btree ("organization_id","period_id","date","start_time");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_locks_organization_id_uq" ON "schedule_locks" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "schedule_locks_lookup_idx" ON "schedule_locks" USING btree ("organization_id","resource_type","resource_id","start_dt","end_dt");--> statement-breakpoint
CREATE INDEX "schedule_notes_organization_program_idx" ON "schedule_notes" USING btree ("organization_id","program_id","created_at");--> statement-breakpoint
CREATE INDEX "schedule_temp_items_organization_period_idx" ON "schedule_temp_items" USING btree ("organization_id","period_id","valid_from","valid_until");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_versions_organization_id_uq" ON "schedule_versions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "schedule_versions_organization_program_idx" ON "schedule_versions" USING btree ("organization_id","program_id");--> statement-breakpoint
CREATE INDEX "schedule_versions_organization_archive_idx" ON "schedule_versions" USING btree ("organization_id","status","archive_section","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "teachers_organization_id_uq" ON "teachers" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "teachers_organization_name_idx" ON "teachers" USING btree ("organization_id","fio");--> statement-breakpoint
CREATE UNIQUE INDEX "time_grids_organization_id_uq" ON "time_grids" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "time_grids_organization_order_idx" ON "time_grids" USING btree ("organization_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "time_slots_organization_id_uq" ON "time_slots" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "time_slots_organization_start_idx" ON "time_slots" USING btree ("organization_id","start");--> statement-breakpoint

DO $tenant_isolation$
DECLARE
	tenant_table text;
BEGIN
	FOREACH tenant_table IN ARRAY ARRAY[
		'programs',
		'periods',
		'program_topics',
		'groups',
		'teachers',
		'rooms',
		'time_slots',
		'time_grids',
		'schedule_items',
		'schedule_locks',
		'schedule_versions',
		'schedule_audit',
		'schedule_notes',
		'schedule_temp_items'
	]
	LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
		EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
		EXECUTE format(
			'CREATE POLICY "organization_isolation" ON %I
			 USING ("organization_id" = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)
			 WITH CHECK ("organization_id" = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)',
			tenant_table
		);
	END LOOP;
END
$tenant_isolation$;
