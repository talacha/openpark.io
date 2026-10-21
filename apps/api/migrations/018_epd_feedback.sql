-- EPD-team feedback: one migration carries every schema change for this task.
-- FEAT-003 (Track C — Resident view) adds the first columns; FEAT-004 and FEAT-005 append their own below.

-- Resident profile picture: an object-storage key (served only via signed URLs), nullable until a photo is uploaded.
alter table app_user add column avatar_key text;

-- Per-resident opt-in to guest check-in/check-out alerts; default true preserves today's behaviour.
alter table app_user add column notify_guest_events boolean not null default true;

-- Who issued a guest pass. Lets the resident-facing history distinguish host- vs attendant-issued passes without
-- exposing the staff member's identity. Nullable: legacy rows predating this migration are labelled neutrally.
alter table pass add column created_by uuid references app_user(id);

-- Who authorized a walk-in's access to the lot, captured at check-in. Nullable JSONB shaped either
-- { "unit": "A-101" } (the attendant named a community unit) or { "name": "...", "phone": "+52..." }
-- (an ad-hoc "Other" authorizer). Always NULL for a pass redemption, whose host unit is the pass's unit.
alter table session add column authorized_by jsonb;
