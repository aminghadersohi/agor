-- Protocol-only offline cutover. No new table: ownership binding uses the existing
-- forced-RLS app_variables contract. Old daemons must be stopped before opting in;
-- they do not participate in the new transaction-level admission fence.
SELECT 1;
