CREATE INDEX "clients_name_trgm" ON "clients" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_name_trgm" ON "contacts" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "locations_name_trgm" ON "locations" USING gin ("name" gin_trgm_ops);