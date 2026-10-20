-- Remove snapshots/templates whose clients were already removed by a merge or organization erasure.
DELETE FROM public.report_runs AS r
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(r.client_ids) AS ref(id)
  WHERE NOT EXISTS (SELECT 1 FROM public.clients AS c WHERE c.org_id = r.org_id AND c.id::text = lower(ref.id))
);
--> statement-breakpoint
DELETE FROM public.report_templates AS t
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(t.definition->'clientIds') AS ref(id)
  WHERE NOT EXISTS (SELECT 1 FROM public.clients AS c WHERE c.org_id = t.org_id AND c.id::text = lower(ref.id))
);
--> statement-breakpoint
-- DELETE's row lock serializes cleanup with the shared locks held by report and template creation.
-- Cover every client deletion path, including duplicate merges and organization-wide erasure.
CREATE FUNCTION public.atlas_purge_client_reports() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.report_runs AS r
    WHERE r.org_id = OLD.org_id AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(r.client_ids) AS ref(id) WHERE lower(ref.id) = OLD.id::text
    );
  DELETE FROM public.report_templates AS t
    WHERE t.org_id = OLD.org_id AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(t.definition->'clientIds') AS ref(id) WHERE lower(ref.id) = OLD.id::text
    );
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER atlas_purge_client_reports
BEFORE DELETE ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.atlas_purge_client_reports();
