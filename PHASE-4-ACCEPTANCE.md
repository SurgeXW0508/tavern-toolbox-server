# Phase 4 Business Provider and Outfit installed-host acceptance

The user confirmed Phase 4 acceptance on 2026-09-27 using official SillyTavern 1.19.0 in Docker on NAS, the `stage/phase-4-business-outfit` frontend and Server candidates, and the same trusted SillyTavern account across phone and computer. This records the observed scope before the `v0.4.0` release; automated negative tests are not represented as NAS observations.

## Installed-host results

| Area | User-confirmed result |
| --- | --- |
| Startup and protocol | Core, Network, Media and Business all reported ready. `business.collections` Protocol 1.0 read and commit worked. The empty Server Outfit Collection read as revision 0, without automatically migrating Local data. |
| Provider and graph | Local and Server were switched explicitly and remained isolated. Person, Item, Outfit, Kit, Wardrobe and WearState were created, read, changed and deleted in the Server library. |
| Media | Server MediaRef images uploaded, served and remained available after refresh. Deleting Business records did not hard-delete Server Media. Explicitly deleting referenced Media left its Business record visible and editable; uploading a replacement repaired the missing image. |
| Devices and concurrency | Phone and computer using the same ST user read and wrote the same Server state. Two-tab stale editor writes produced a conflict without silent overwrite, both for text-only edits and edits with Media upload. The draft remained available; the user explicitly read the latest state before manually rebasing. |
| Availability and UI | Server unavailability kept the Server Provider selected without falling back to Local; an explicit switch to Local worked. Shared form, action and confirmation Dialogs were checked on the real phone. |
| Durability and coexistence | Business, Media and WearState survived Docker restart. The Server coexisted with the installed 柏宝库 plugin. |
| Cold restore | With SillyTavern stopped, the full `tavern-toolbox-server` user data directory was copied, including Business SQLite, Media metadata and Originals/Derived files. Cold restore reproduced the saved Business revision, MediaRef and original image. The latest pre-test data was then restored successfully. |

The installed host has only `default-user`; a second SillyTavern user was **not** created for acceptance. Trusted user-root isolation is covered by automated tests, not claimed as installed-host verification. Malformed schemas, malicious requests and other negative cases are likewise automated evidence unless stated above. The Server's collection CAS and separate Media ownership remain the implementation boundaries.

## Automated and release gates

The test suite covers trusted user-root isolation, collection revision races, graph and MediaRef validation, storage recovery, middleware behavior and failure isolation. The production ST Docker image lacks the openssl CLI: exactly two self-signed HTTPS/CONNECT fixture tests clearly skip there; the plugin has no production openssl CLI dependency. Candidate CI has openssl and runs those Network safety tests in full, failing if the CLI disappears.

Before release, run a clean install, `npm run check` and `npm run audit:privacy` against the final branch. The latter checks tracked content and reachable Git metadata; keep real user paths, private proxy endpoints, cookies, CSRF tokens, emails and credentials out of public evidence. Release `v0.4.0` must be built from the reviewed `main` commit. Operational backup includes Business and Media together while the host is stopped; a source tag does not restore user data.
