-- Platform admins invite the first owner of a new organisation by email.
alter table membership_invite drop constraint membership_invite_role_check;
alter table membership_invite add constraint membership_invite_role_check
  check (role in ('owner', 'admin', 'supervisor', 'attendant', 'auditor', 'resident'));
