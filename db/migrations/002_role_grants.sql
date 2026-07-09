grant usage on schema raw, core, calc, reporting, sync to bowlus_app;
grant usage on schema calc, reporting to bowlus_readonly;

grant select on all tables in schema raw, sync to bowlus_app;
grant select on all tables in schema calc, reporting to bowlus_readonly;
grant select on all tables in schema calc, reporting to bowlus_app;

grant select, insert, update on all tables in schema core to bowlus_app;
grant usage, select, update on all sequences in schema core to bowlus_app;

alter default privileges in schema calc, reporting
  grant select on tables to bowlus_readonly;

alter default privileges in schema calc, reporting
  grant select on tables to bowlus_app;

alter default privileges in schema raw, sync
  grant select on tables to bowlus_app;

alter default privileges in schema core
  grant select, insert, update on tables to bowlus_app;

alter default privileges in schema core
  grant usage, select, update on sequences to bowlus_app;
