-- A supervisor can attach a photo to an overstay fine, not only to an unlinked immobilization. Both actions keep
-- their other invariants; only the evidence requirement changes.
alter table enforcement_case drop constraint if exists enforcement_case_check;
alter table enforcement_case add constraint enforcement_case_check check (
  (action = 'fine' and unit_id is not null and amount_minor = 500000 and currency = 'MXN')
  or (action = 'immobilization' and unit_id is null and amount_minor is null and currency is null and evidence_key is not null)
);
