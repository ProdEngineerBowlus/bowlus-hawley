-- Gates pass automatically once every task in the stage is complete, as long as the gate has no checks to tick
-- (checks always need a person). An admin can still override with a reason. On by default for the Frames gate.
alter table hb.workflow_gates add column if not exists auto_pass boolean not null default true;
