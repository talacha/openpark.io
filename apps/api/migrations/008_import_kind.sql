-- Import jobs now cover more than slot inventory (units, and residents inside them).
alter table inventory_import add column kind text not null default 'inventory' check (kind in ('inventory', 'units'));
