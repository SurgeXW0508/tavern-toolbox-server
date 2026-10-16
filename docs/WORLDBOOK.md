# Worldbook — Phase 10C candidate

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

Schema is explicitly `PRAGMA user_version=2`. Opening schema 1 upgrades it in one SQLite transaction, preserving all existing identities and metadata. Failure rolls back; no reset/replacement is performed. The recognized earlier unreleased v1 two-column Tag table receives an atomic additive position column/backfill, retaining its previously displayed alphabetical order and all entity IDs/data; subsequent writes preserve entered order. No other unknown table shape is upgraded. A future version, nonempty
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
| tags | Indexed bounded tags per Material, with explicit presentation position |
| commands | Expiring durable command digest and minimal acknowledgment, never a Material Description copy |

Same-source Materials are independent cards. Move preserves Material ID; Copy
creates a new one. Rename and explicit source rebind preserve ID. Source locator
is used to find/reuse a Source row; the Source's identity is its persistent ID,
not its display name. Binding lifecycle is active/detached; read failure remains transient unknown. See the 10C rules below.
Source identities survive while referenced. The command transaction removes rows after their last Material reference disappears, then checks the 256-Source final-set budget. Shared Sources remain; rebind at capacity can replace its last old reference; overflow rolls back the entire command. Receipts are independent of Source rows and still resolve uncertain retries. Earlier orphan rows are reclaimed by the next successful command.

ST exclusively owns Entry body, keywords, existence, Enabled and Mode. The Server
does not read/write ST worldbooks, store their runtime or create placeholder
Entries. Explicit imports and manual rebinding identify a real selected locator
and UID. Last-known title is descriptive, not the Material identity. A detached Binding never revives from UID reuse; explicit repair or continuity confirmation is required.

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
| Tree | 50 lightweight nodes/response; view auto-loads at most 4 chunks (200 nodes), then explicitly appends the same preorder prefix; parent-before-child; `treeRevision:offset` continuation rejects changed trees; no long text or per-folder request fan-out |
| Detail | One exact Material, including Description; frontend keeps at most 8 recent Details in memory |
| Referenced Sources | 50/page, maximum 256 retained Source identities; no Entry data |
| Runtime lookup | Temporary session: 100 locator/UID inputs/batch, maximum 8192 legacy enabled bindings or 65536 observed UID/enabled inputs; 60 seconds, 2/user and 8 globally, bound to user/context |
| Commands | 256 KiB request, 100 import Materials/command, maximum 50,000 Materials and 10,000 Folders/user, Folder depth 16 |

Names are at most 80 UTF-16 units, type 60, Summary 160, Description 20,000,
16 tags of 32 each, Source locator 240, last-known title 200, query 160. See the
advertised `limits` for the exact machine-readable budgets. Each new reference
appears in the command's source delta before frontend native refresh. Explicit
refresh and newly encountered cross-device Sources reconcile the referenced
Source summary; tracking uses exact replacement, not permanent append.

Runtime generation waits for the frontend Lorebook index loadedTrackingVersion to match the current Provider tracked set, including the first query after a Local cache. Ordinary paging reuses that index. Token caching uses a conservative local monotonic TTL; an expired-token Catalog read rebuilds/requeries once, without retrying business commands. Runtime sessions exist only in memory. Catalog intersects a materialized
temporary JSON-input relation with indexed Source/Material identities before
grouping; it does not parse all runtime inputs again for every Material. The
frontend never downloads the full Server Catalog to calculate native counts.
Catalog now supports persisted detached and runtime enabled/disabled/unknown filters plus SQL recent/frequent sorting.

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

Column imports accept an explicit importFolderName independently of the Column title, preserving the Wizard Source grouping. Tag input order survives create/update/copy/restart; SQL filtering and grouping remain independent of order.

Frontend operation errors (capacity, command expiry, runtime expiry, busy, CSRF) remain local to that action. Provider/transport/schema failure and negotiated read/write availability are independent; first Local-to-Server selection preflights compatible basic read operations before committing the device preference. Already selected Server outages never fall back.

Error codes distinguish validation, conflict, not-found, builtin protection,
capacity, expired/mismatched commands, clock skew, expired runtime, changed Tree,
schema incompatibility, unavailable capability/connection and Origin/CSRF failure.
Logs contain request ID, operation, duration and code, not payloads, descriptions,
summaries, tag arrays or original Source names.

## 10C domain and query contracts

Schema 2 adds wb_bindings, wb_usage, wb_relation_versions, wb_companions,
wb_presets and wb_preset_members, with FK/triggers for atomic move/delete cleanup.
The original worldbook-v1 location and Core 1.0 wire shape remain; capability
constraints advertise storageSchemaVersion=2 and featureVersion=1. Metadata,
Binding, Companion and Preset revisions are independent. Usage uses SQL increment
and the existing durable receipt, not an absolute client-supplied count.

Binding observations contain expected Material/Source/locator/UID/revision.
Stale evidence is skipped, unknown cannot be persisted, title updates do not
change custom Material names. Whole-book rebind keeps Source ID, rejects a target
owned by another Source, marks an explicit repair intent, then frontend native
observations classify every affected binding. Read failures leave repair pending.

Companion uses Material IDs, max 64 outgoing, no self/duplicate; copy outgoing
only, move preserves, delete cleans both directions. Presets use Material IDs,
max 1024 entities, independent entity CAS; membership changes <=100 add/remove.
Column plans are exact-state logical Source/UID projections with selected ON
precedence. Global plans are additive. Detached members remain stored and are
reported skipped. An exact plan rejects incomplete observed runtime before any
ST change. Capture-current uses server SQL and a transient runtime token;
receipt replay works even after the runtime token expires.

POST /v1/worldbook/features is a protected read operation, not a business writer.
All inputs have strict field whitelists. Bounds: bindings 50 compact records with
keyset continuation; relationship picker 20/page including SQL-projected draft
add/remove before selected pagination; Preset list 20/page; facets 50/page;
Preset execution plan 50/page; classification search 10 hits plus <=160 ancestors.
No Description enters bindings, relationship or candidate windows.

Observed runtime adds mode=observed, enabled booleans and a first-batch unknownBooks
list. It is user/context bound, in memory only, 100 inputs/batch, 60-second TTL.
No SQLite enabled/mode/body copy exists. Normal 10B enabled-only runtime remains
accepted. Random Roll/Discovery windows require complete observed runtime;
SQL filters and groups logical sources before seeded keyset traversal. Each
session stores only seed/scope/cursor and the last bounded reply, <=20 cards,
15-minute TTL, 4/user and 16 global. No full browser/server session ID pool.
Discovery returns lightweight metadata and <=16 folder names, never Description.
Server rejects AI keys/chat/prompt fields; frontend owns the single AI request.

Bounds describe response/memory growth, not constant execution time. Substring
search, facets/counts and seeded ordering may scan the relevant SQL scope.
Native ST reads remain whole-book. No claim about NAS/phone latency follows from
cloud tests.

## Candidate, upgrade and remaining gate

Both repositories use stage/phase-10-worldbook-server. Keep frontend/server paired;
no main merge, release bump or 10D before review and real-device acceptance.

For a NAS update: stop ST/container; back up each ST user's complete
`tavern-toolbox-server/worldbook-v1` directory outside the code checkout; update
this stage branch with a fast-forward pull and run the normal dependency install
for the deployed Node 24 runtime, preserve the ST data volume, then restart.
Import the paired frontend candidate with its stable script ID using overwrite.
Opening an old Worldbook database performs the schema 1→2 transaction; never
remove the database to make an upgrade succeed. Code rollback alone cannot make
10B understand schema 2: stop ST and restore the complete pre-upgrade directory
when an explicit rollback is required.

Automated tests cover migration rollback/reopen, CAS, relationship/preset cleanup,
two SQLite connections incrementing Usage, idempotent capture/retry, lifecycle
and stale evidence, Source collision, bounded searches and candidate traversal,
HTTP observed-runtime batching, privacy and Unicode response budgets. Frontend
Chromium tests use this real HTTP/SQLite implementation with synthetic native ST
and AI; they do not replace real-user data/device evidence.

The remaining real-device gate is migration with existing data/restart,
PC↔Phone identity/data persistence, Companion order/partial failure, Column vs
Global Preset semantics/CAS, Usage transitions/recent/frequent, rename/missing/
unreadable/UID reuse/explicit repairs, beyond-page Roll/no repeats, Discovery
single request/window/confirmation, classification ancestor search, unavailable
Server without Local fallback and retry recovery. See paired frontend TESTING.md.
