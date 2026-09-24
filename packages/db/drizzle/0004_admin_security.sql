CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "password_group_access" (
	"password_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "password_group_access_password_id_group_id_pk" PRIMARY KEY("password_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trusted_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "security_events" ADD COLUMN "prev_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "security_events" ADD COLUMN "hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "reauth_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "challenge" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "passkey_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "notify_digest" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_group_access" ADD CONSTRAINT "password_group_access_password_id_passwords_id_fk" FOREIGN KEY ("password_id") REFERENCES "public"."passwords"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_group_access" ADD CONSTRAINT "password_group_access_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_log_sent" ON "notification_log" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "passkeys_user" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "password_resets_user" ON "password_resets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_devices_token" ON "trusted_devices" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "trusted_devices_user" ON "trusted_devices" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_org_name" ON "groups" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_id" ON "sessions" USING btree ("id");--> statement-breakpoint
-- Tamper-evident audit log: every security event carries the hash of the previous event in its organization.
-- user_id is left out because it is cleared if a user is ever deleted; the actor's name is kept in the row.
CREATE FUNCTION atlas_event_hash(prev text, e security_events) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws(E'\x1f',
    prev, e.id::text, coalesce(e.org_id::text, ''), e.actor, e.action, e.detail, e.ip,
    to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')
  ), 'UTF8')), 'hex')
$$;--> statement-breakpoint
CREATE FUNCTION atlas_chain_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE last text;
BEGIN
  -- One writer per organization at a time, so the chain never forks.
  PERFORM pg_advisory_xact_lock(hashtext('atlas-audit:' || coalesce(NEW.org_id::text, '')));
  -- Take the ID only after the lock: the default was drawn before it, so concurrent inserts could otherwise
  -- get IDs in a different order from the chain.
  NEW.id := nextval(pg_get_serial_sequence('security_events', 'id'));
  SELECT hash INTO last FROM security_events
    WHERE org_id IS NOT DISTINCT FROM NEW.org_id ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := coalesce(last, '');
  NEW.hash := atlas_event_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION atlas_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Clearing user_id (a deleted account) is the only permitted change.
  IF NEW.id = OLD.id AND NEW.hash = OLD.hash AND NEW.prev_hash = OLD.prev_hash AND NEW.actor = OLD.actor
     AND NEW.action = OLD.action AND NEW.detail = OLD.detail AND NEW.ip = OLD.ip
     AND NEW.created_at = OLD.created_at AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'security_events rows cannot be changed';
END $$;--> statement-breakpoint
DO $$
DECLARE r security_events; last text; o uuid; first boolean := true;
BEGIN
  FOR r IN SELECT * FROM security_events ORDER BY org_id NULLS FIRST, id LOOP
    IF first OR r.org_id IS DISTINCT FROM o THEN last := ''; o := r.org_id; first := false; END IF;
    r.prev_hash := last;
    last := atlas_event_hash(last, r);
    UPDATE security_events SET prev_hash = r.prev_hash, hash = last WHERE id = r.id;
  END LOOP;
END $$;--> statement-breakpoint
CREATE TRIGGER security_events_chain BEFORE INSERT ON security_events
  FOR EACH ROW EXECUTE FUNCTION atlas_chain_event();--> statement-breakpoint
CREATE TRIGGER security_events_immutable BEFORE UPDATE ON security_events
  FOR EACH ROW EXECUTE FUNCTION atlas_event_immutable();
