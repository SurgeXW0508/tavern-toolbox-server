# Worldbook Core — Phase 10B candidate

`worldbook.core` contract 1.0 is an independent business module, not an Outfit
collection or a Media/Reference Provider. Protocol remains 1.0; release versions
remain Server 0.9.0 / Frontend 0.52.0 until formal acceptance and release.

## Ownership and storage

Each trusted `context.userRoot` owns
`tavern-toolbox-server/worldbook-v1/worldbook.sqlite`. The directories are 0700,
the database 0600, with foreign keys and SQLite FULL durability. Node with
`node:sqlite` is required (use Node 24 as in CI). A connection is opened lazily
per authenticated user and closed on module shutdown. No business data is kept
in the plugin code directory. Preserve the ST data volume across container
restarts. This stage does not implement a backup product; with ST stopped,
preserve the complete `worldbook-v1` directory for an operator backup. A code
rollback does not roll back this database.

Schema is explicitly `PRAGMA user_version=1`. A future version, nonempty
unversioned database or missing required tables fails closed; startup never
resets existing records. The two product builtins (`xp-worldbook`,
`fate-worldbook`) are initialized only with a new schema, empty of Materials.
Their appearance/deletion is protected; their contents remain editable.

| Entity/table | Meaning |
| --- | --- |
| columns | Stable ID, appearance, order, builtin flag, metadata revision, structure revision, tree revision |
| folders | Stable ID, owning Column, parent Folder, name, sibling order, entity revision |
| materials | Stable ID, Column/parent placement, card metadata, Source ID + UID + last-known title, entity revision |
| material_details | The Material's original long Description and derived Unicode-folded search text, separate from card/structure rows |
| sources | Stable opaque ID, exact ST worldbook locator and display metadata; no Entry/runtime copy |
| tags | Indexed bounded tags per Material |
| commands | Expiring durable command digest and minimal acknowledgment, never a Material Description copy |

Same-source Materials are independent cards. Move preserves Material ID; Copy
creates a new one. Rename and explicit source rebind preserve ID. Source locator
is used to find/reuse a Source row; the Source's identity is its persistent ID,
not its display name. Advanced rename/repair/detached lifecycle is deferred.
Unreferenced Source identities remain in the database; only referenced Sources
are returned for frontend tracking. Source capacity includes retained identities.

ST exclusively owns Entry body, keywords, existence, Enabled and Mode. The Server
does not read/write ST worldbooks, store their runtime or create placeholder
Entries. Explicit imports and manual rebinding identify a real selected locator
and UID. Last-known title is descriptive, not the Material identity. Native UID
reuse/repair semantics beyond this explicit binding belong to 10C.

## Query and resource bounds

All HTTP routes require the ST session, current `X-TTB-Context`, Protocol 1.0 and
the corresponding capability operation. Runtime input and commands additionally
require trusted Origin and host CSRF. Missing Origin policy disables these two
operations while read/query operations remain usable. Inputs reject unknown
fields and overlong values rather than truncating user text. Responses are
private/no-store and at most 128 KiB; the frontend's ordinary 256 KiB limit is
unchanged. The wire surface is listed in [Protocol](../protocol/README.md).

| Surface | Bound and semantics |
| --- | --- |
| Home Summary | 32 Columns/page, maximum 128 Columns; counts in SQL, no Material Detail or Tree |
| Catalog | 20 cards/page, no Description; exact Column/type, tags AND, favorite, Chinese/Latin case-insensitive/numeric substring search |
| Global aggregation | Filter, group Source ID + UID, stable Column/order/ID tie sorting, then paginate; Column/explicit source lookup returns individual Materials |
| Tree | 50 lightweight nodes/page, parent-before-child; `treeRevision:offset` continuation rejects changed trees; no long text or per-folder request fan-out |
| Detail | One exact Material, including Description; frontend keeps at most 8 recent Details in memory |
| Referenced Sources | 50/page, maximum 256 retained Source identities; no Entry data |
| Runtime lookup | Temporary session: 100 locator/UID inputs/batch, maximum 8192; 60 seconds, 2/user and 8 globally, bound to user/context |
| Commands | 256 KiB request, 100 import Materials/command, maximum 50,000 Materials and 10,000 Folders/user, Folder depth 16 |

Names are at most 80 UTF-16 units, type 60, Summary 160, Description 20,000,
16 tags of 32 each, Source locator 240, last-known title 200, query 160. See the
advertised `limits` for the exact machine-readable budgets. Each new reference
appears in the command's source delta before frontend native refresh. Explicit
refresh and newly encountered cross-device Sources reconcile the referenced
Source summary; tracking uses exact replacement, not permanent append.

Runtime sessions exist only in memory. Catalog intersects a materialized
temporary JSON-input relation with indexed Source/Material identities before
grouping; it does not parse all runtime inputs again for every Material. The
frontend never downloads the full Server Catalog to calculate native counts.
Unsupported derived filters/sorts are absent in 10B.

Bounded response does not mean O(pageSize) database work. SQL window grouping and
substring search may scan the matching scope; Description search reads long
text, and large Tree ordering visits lightweight structure. Card/Detail physical
separation keeps ordinary reads independent of Description storage I/O. The
Unicode-folded Description is updated only with that Material, so repeated
queries do not repeatedly call JavaScript/ICU for every long body. The original
Description is preserved exactly; folded text never appears in a DTO. There is
no full-text index or claim about NAS latency. A synthetic 3,200-Material / 34-
Column dataset with 16,000-character Descriptions measured ordinary Catalog
median about 26 ms / 8.8 KB, Tree about 1 ms / 13.8 KB, one Detail about 0.3 ms /
48.7 KB, and all-matching Description search about 226 ms in this cloud runtime;
8192 runtime inputs remained about 46 ms. These observations are not device
budgets. The same dataset before splitting Details measured Catalog about
117 ms and runtime lookup about 127 ms. True NAS search/interaction remains a
real-device gate.

## Concurrency, atomicity and retries

Material metadata uses its own revision CAS: edits to A and B do not conflict.
Structural create/move/copy/delete uses the relevant Column structureRevision;
cross-column commands check both Columns. Folder edits also check entity revision.
Tree revision changes invalidate continuations without making it the global
business write revision. Column metadata uses entity CAS; ordering checks the
selected and target Column revisions and normalizes only the bounded custom
Column order atomically, including tied positions. Builtin order is unchanged.

Every command, including update/delete/move, carries
`<13-digit-time>-<UUID>` as `commandId`. New commands accept at most five minutes
of future clock skew and seven days of age. A transaction checks the SHA-256
digest of canonical action/data, performs the business operation, and records
its minimal acknowledgment before commit. Exact retry returns the original
acknowledgment before checking now-stale entity revisions, with `replayed:true`.
The client then reads current bounded Column/Source summaries rather than
reapplying historical source deltas or resurrecting a later-deleted Column. Changed content with
the same ID fails. Receipts survive restart; expired command IDs are refused
even after receipt expiry, so they cannot silently create a second entity.
There are at most 16,384 unexpired receipts/user; overflow fails explicitly.
There is no background retry, rollback of ST or distributed collaboration layer.

Frontend writes are server-confirmed. Uncertain form retries keep the same ID
and data. An uncertain form retains and locks the original inputs until
confirmation, so editing an uncertain Create cannot silently become a second
Create. After an explicit rejection/latest-value read, changing the draft gets
a new command ID. Long-form conflict keeps
the form open and its inputs intact. Reading the latest revision adds a
comparison, then the user explicitly decides whether to save again. Structural
conflicts require fresh structure/user action. Create forms can refresh the
structure while retaining inputs. Abort/disconnect does not imply a server
rollback; use the original command receipt to resolve uncertainty.

Error codes distinguish validation, conflict, not-found, builtin protection,
capacity, expired/mismatched commands, clock skew, expired runtime, changed Tree,
schema incompatibility, unavailable capability/connection and Origin/CSRF failure.
Logs contain request ID, operation, duration and code, not payloads, descriptions,
summaries, tag arrays or original Source names.

## Candidate and remaining gate

Both repositories use `stage/phase-10-worldbook-server`. Do not merge, bump a
release version, tag/release or start 10C before independent review and the
Desktop/Phone/NAS gate. Frontend selection is device-local; switching cancels old
requests, clears Provider caches, replaces tracked books and returns Home. Local
and Server never migrate, sync or fall back to each other. Existing Local Cover,
Backup, Preset, Roll and Discovery keep their original data paths. Server does
not expose those capabilities or load their Local data.

Automated Store/HTTP coverage includes restart, per-user isolation, explicit
Source, stable identities, query bounds/grouping/filter/search, tree continuation,
entity/structure conflicts, atomic rollback, folder delete intents, copy/create/
delete retry after restart, maximal Unicode payloads and runtime expiry. Paired
frontend tests and real Chromium/HTTP fixtures cover isolation, source switching,
late requests, rapid input, draft conflict/retry, read-only/failure, native source
tracking and responsive presentation. These are code-side evidence. Local full
check encounters the sandbox's existing abstract Unix socket policy-lock EPERM;
diagnostic selection is not a full-suite pass. CI runs the unchanged complete
check and privacy audit.

Real-device gate: carry forward the seven short 10A polish checks, then verify
independent empty Server data, non-active-worldbook import, Material edit,
Folder/Move/Copy, search/page/detail, browser refresh and Server/container restart,
same ST account on Phone, distinct-Material concurrent edits, same-Material stale
conflict preserving input, temporary outage with no fallback, recovery and
repeated Local/Server isolation. 10C retains Companion/Presets/Roll/Discovery/
Usage/Recent/Frequent/Missing and Source Lifecycle; 10D retains Cover/Media.
