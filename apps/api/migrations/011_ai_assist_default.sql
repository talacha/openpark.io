-- Plate reading runs on the device (no server worker, no per-read cost), so it is on by default: the camera suggests,
-- the attendant confirms ('assist'). Organisations that explicitly chose 'auto' are untouched.
alter table tenant alter column ai_mode set default 'assist';
update tenant set ai_mode = 'assist' where ai_mode = 'off';
