# Asana Project Creator GID Inventory

Read-only inventory captured 2026-07-13 from the Bowlus Asana workspace and
recent production projects `326 - Frontier` and `F12.26`.

## Project destinations

| Resource | GID |
| --- | --- |
| Bowlus workspace | `829365006370166` |
| Production team | `1199106825647568` |
| Current project template | `1211664083967075` |
| VINs - 2026 portfolio | `1212620750946276` |
| Fabrication - 2026 portfolio | `1212620750946278` |

The current template is named `Project Upload Template (ACTIVE)`. Direct
project creation can target the Production team and then add the new project
to the appropriate portfolio without instantiating this template.

## Stable workspace custom fields

| Field | GID | Type | Notes |
| --- | --- | --- | --- |
| Estimated time | `1208345165206058` | number | Writable; value is minutes. |
| Estimated Time (w/ Qty) | `1208854525971252` | formula/number | Do not write; attach to project and let Asana calculate. |
| Quantity | `1208345982510557` | number | Writable. |
| VIN | `1208346878390176` | multi-enum | Current options stop at VIN 321. |
| Cycle | `1203060130064229` | enum | Includes `C12.26` through `C24.26`. |
| Phase / Section | `1207105939484341` | enum | Includes CNC, Frames, Fab, and Phase A-H. |
| Model | `1208702088573486` | enum | Includes Frontier and the established model values. |
| Est Time Remaining (Project) | `1208347136544342` | formula/number | Project reporting formula; do not write. |
| SOP Link | `1211295831856206` | text | Writable. |
| TasksKey | `1211631396593040` | text | Writable. |
| CNC Parts | `1211295743487169` | text | Present on recent VIN and Fabrication projects. |
| Task Order | `1208563286024683` | number | Workspace version exists, although the template currently clones a local version. |
| Assigned On | `1215603865689876` | date | Workspace version exists, although the template currently clones a local version. |

## Template-created local fields

These fields receive a different GID on each instantiated project. They cannot
be safely configured as fixed GIDs from an existing project.

| Field | 326 project GID | F12.26 project GID | Type |
| --- | --- | --- | --- |
| Task Order | `1215946435239533` | `1216424179093306` | number |
| Task ID | `1215946435239540` | `1216424179093313` | text |
| Days in Cycle | `1215946435239547` | `1216424179093320` | number |
| Assignee Email | `1215946435239590` | `1216424270754150` | people |
| Attachment summary | `1215946435239597` | `1216424270754157` | text |
| AirTableKey | `1215946435239604` | `1216424270754164` | text |
| Assigned On | `1215963210544230` | `1216424421802440` | date |

For direct creation, Hawley reuses the stable workspace versions of `Task
Order` and `Assigned On`. It creates project-local `Days in Cycle`, `Attachment
summary`, and `AirTableKey` fields. `Task ID` and `Assignee Email` are not
required by the current server creator because it assigns the task directly and
stores the task-template identity in `TasksKey`.

## Required enum work

- Add VIN options 322 through at least 328 to field `1208346878390176` before
  expecting Hawley to populate the VIN field for current projects.
- Hawley must write VIN as a `multi_enum` option GID, not as a number.
- `C12.26` is option `1212650056015341` in Cycle field `1203060130064229`.
- Phase option GIDs are stable under field `1207105939484341`; lookup should be
  by normalized option name rather than hard-coded per task.

## Sections

Section GIDs are project-specific and must always be created for a new direct
project. The established sets are:

- VIN: `Phase A` through `Phase H`.
- Fabrication: `Frames`, `CNC`, and `FAB`.

The `Untitled section` seen on template-instantiated projects is not required.

## Direct-create readiness

Hawley's direct-create implementation now:

1. Create an empty project in Production team `1199106825647568`.
2. Attach the stable workspace fields above.
3. Create local `Days in Cycle`, `Attachment summary`, and `AirTableKey`
   fields while attaching the shared `Assigned On` date field.
4. Ensure the required VIN option exists and write its multi-enum option GID.
5. Create only the appropriate VIN or Fabrication sections.
6. Add the project to its 2026 portfolio.

`Assigned On` is attached as a date field but intentionally left blank for the
line lead to assign. `AirTableKey` is also left blank until the Airtable
backfill assigns the actual Airtable record key. No reusable template tasks
were identified as necessary for project creation.
