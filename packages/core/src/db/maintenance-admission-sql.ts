/**
 * Versioned operational extension, deliberately outside tenant application data
 * and Drizzle's migration ledger. Installed ONLY by the explicit operator CLI.
 * Can fence an older binary before its first capability-aware restart. No
 * tenant rows, task outcomes, schedules, credentials or tokens are rewritten.
 */
export const MAINTENANCE_SCHEMA_VERSION = 1;
export const MAINTENANCE_POLICY =
  "(current_setting('agor.system_scope'::text, true) = 'maintenance_admission_discovery'::text)";

// A row lock lasts through the actual admission commit. Acquisition waits for
// earlier admissions; later admissions see the committed hold, even in an old
// daemon. In draining, previously admitted Tasks may finish naturally. Sealing
// requires stable global zero; it also refuses any late executor transition.
export const MAINTENANCE_TRIGGER_BODY = `
DECLARE control agor_maintenance.control%ROWTYPE; admission boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'tasks' THEN
    admission := TG_OP = 'INSERT';
    IF TG_OP = 'UPDATE' THEN
      admission := NEW.status NOT IN ('completed','failed','stopped','timed_out')
        AND OLD.status IS DISTINCT FROM NEW.status;
    END IF;
  ELSIF TG_TABLE_NAME = 'sessions' THEN
    admission := TG_OP = 'INSERT';
  ELSIF TG_TABLE_NAME = 'branches' THEN
    IF TG_OP = 'INSERT' THEN
      admission := true;
    ELSE
      admission :=
        (NEW.data #>> '{environment_instance,command_attempt,id}' IS DISTINCT FROM OLD.data #>> '{environment_instance,command_attempt,id}'
          AND NEW.data #>> '{environment_instance,command_attempt,id}' IS NOT NULL)
        OR (NEW.data #>> '{maintenance,operation_id}' IS DISTINCT FROM OLD.data #>> '{maintenance,operation_id}'
          AND NEW.data #>> '{maintenance,operation_id}' IS NOT NULL)
        OR (NEW.data #>> '{maintenance,execution_id}' IS DISTINCT FROM OLD.data #>> '{maintenance,execution_id}'
          AND NEW.data #>> '{maintenance,execution_id}' IS NOT NULL)
        OR (NEW.filesystem_status = 'creating' AND OLD.filesystem_status IS DISTINCT FROM 'creating');
    END IF;
  END IF;
  IF NOT admission THEN RETURN NEW; END IF;
  SELECT * INTO STRICT control FROM agor_maintenance.control WHERE singleton FOR SHARE;
  IF control.phase = 'released' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'tasks' AND TG_OP = 'UPDATE' AND control.phase = 'draining'
    AND OLD.status NOT IN ('completed','failed','stopped','timed_out') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Maintenance admission held; inspect before resubmitting';
END
`;

export const INSTALL_MAINTENANCE_ADMISSION_SQL = `
LOCK TABLE public.branches, public.sessions, public.tasks IN SHARE ROW EXCLUSIVE MODE;
CREATE SCHEMA agor_maintenance;
REVOKE ALL ON SCHEMA agor_maintenance FROM PUBLIC;
CREATE TABLE agor_maintenance.control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version integer NOT NULL CHECK (version = 1),
  phase text NOT NULL CHECK (phase IN ('released','draining','sealed')),
  generation text,
  expires_at timestamptz,
  idle_since timestamptz,
  operator_role text NOT NULL
);
INSERT INTO agor_maintenance.control(singleton,version,phase,operator_role)
  VALUES (true,1,'released',current_user);
CREATE TABLE agor_maintenance.audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  event text NOT NULL,
  generation text NOT NULL,
  operator_role text NOT NULL
);
REVOKE ALL ON ALL TABLES IN SCHEMA agor_maintenance FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA agor_maintenance FROM PUBLIC;
CREATE FUNCTION agor_maintenance.admission() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
  AS $maintenance$${MAINTENANCE_TRIGGER_BODY}$maintenance$;
REVOKE ALL ON FUNCTION agor_maintenance.admission() FROM PUBLIC;
CREATE TRIGGER agor_maintenance_admission BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION agor_maintenance.admission();
CREATE TRIGGER agor_maintenance_admission BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION agor_maintenance.admission();
CREATE TRIGGER agor_maintenance_admission BEFORE INSERT OR UPDATE ON public.branches
  FOR EACH ROW EXECUTE FUNCTION agor_maintenance.admission();
CREATE POLICY maintenance_admission_discovery ON public.tasks FOR SELECT USING ${MAINTENANCE_POLICY};
CREATE POLICY maintenance_admission_discovery ON public.branches FOR SELECT USING ${MAINTENANCE_POLICY};
`;
