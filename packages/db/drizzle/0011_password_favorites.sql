CREATE TABLE "password_favorites" (
	"user_id" uuid NOT NULL,
	"password_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_favorites_user_id_password_id_pk" PRIMARY KEY("user_id","password_id")
);
--> statement-breakpoint
ALTER TABLE "password_favorites" ADD CONSTRAINT "password_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_favorites" ADD CONSTRAINT "password_favorites_password_id_passwords_id_fk" FOREIGN KEY ("password_id") REFERENCES "public"."passwords"("id") ON DELETE cascade ON UPDATE no action;