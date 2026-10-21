-- Each guest-pass QR carries a random verification code, stored here and replaced whenever the QR is regenerated.
alter table pass add column verify_code text;
update pass set verify_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 10) where verify_code is null;
alter table pass alter column verify_code set not null;
