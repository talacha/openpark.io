-- Units are homes: a floor (number) and a free-text note join the code, name and site.
alter table unit add column floor int;
alter table unit add column note text;
