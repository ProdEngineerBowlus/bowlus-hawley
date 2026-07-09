grant usage on schema raw, core, calc, reporting, sync, hb, ops to bowlus_app;

grant select on all tables in schema raw, sync, hb, ops, calc, reporting to bowlus_app;
grant select on all tables in schema hb, ops, calc, reporting to bowlus_readonly;

alter default privileges in schema raw, sync, hb, ops, calc, reporting
  grant select on tables to bowlus_app;

alter default privileges in schema hb, ops, calc, reporting
  grant select on tables to bowlus_readonly;
