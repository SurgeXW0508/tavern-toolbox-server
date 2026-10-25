import { object, uuid, integer, text, fail, aborted } from './validation.js';
import { rootFor, openVideo } from './roots.js';
import { readProgress, writeProgress } from './progress.js';

export function createVideoManagement({ store, run, policy, discovery, media, coordinate, references, now, cancelStreams }) {
    const current = (context, item, id) => { const row = item.row(id); rootFor(policy, context, row.root_key); return row; };
    return {
        operation(context, id, signal) { return run(context, signal, async signal => {
            const item = await store(context); aborted(signal); const receipt = item.operation(id, now());
            return receipt ? { found: true, result: JSON.parse(receipt.result_json) } : { found: false };
        }); },
        update(context, id, input, signal) { return run(context, signal, async signal => {
            object(input, ['operationId', 'metadataRevision', 'patch'], ['operationId', 'metadataRevision', 'patch']); uuid(input.operationId); integer(input.metadataRevision);
            object(input.patch, ['title', 'posterRef']);
            if (!Object.keys(input.patch).length) fail('INVALID_REQUEST');
            const patch = {};
            if ('title' in input.patch) patch.title = text(input.patch.title);
            if ('posterRef' in input.patch) {
                if (input.patch.posterRef !== null) { object(input.patch.posterRef, ['provider', 'assetId'], ['provider', 'assetId']); if (input.patch.posterRef.provider !== 'server') fail('INVALID_REQUEST'); uuid(input.patch.posterRef.assetId); }
                patch.posterRef = input.patch.posterRef;
            }
            const item = await store(context), hash = item.requestHash(['update', id, input.metadataRevision, patch]);
            return coordinate(context, async () => {
                aborted(signal); const row = current(context, item, id);
                const replay = item.operation(input.operationId, now());
                if (!replay && patch.posterRef) {
                    try { const metadata = await media.metadata(context, patch.posterRef.assetId), health = await media.health(context, patch.posterRef.assetId);
                        if (metadata.kind !== 'image' || health.original !== 'healthy') fail('VIDEO_POSTER_UNAVAILABLE'); }
                    catch { fail('VIDEO_POSTER_UNAVAILABLE'); }
                }
                aborted(signal);
                return item.command(input.operationId, hash, now(), () => {
                    if (row.metadata_revision !== input.metadataRevision) fail('VIDEO_METADATA_CONFLICT');
                    item.db.prepare('UPDATE videos SET title=?,poster_asset_id=?,metadata_revision=metadata_revision+1 WHERE id=?')
                        .run(patch.title ?? row.title, 'posterRef' in patch ? patch.posterRef?.assetId ?? null : row.poster_asset_id, id);
                    return item.view(item.row(id));
                });
            });
        }); },
        progress(context, id, input, signal) { return run(context, signal, async signal => {
            const item = await store(context); aborted(signal);
            // Synchronous SQLite CAS; no file I/O or reference enumeration.
            const row = current(context, item, id);
            return input === null ? readProgress(item, row) : writeProgress(item, row, input, now());
        }); },
        references(context, id, signal) { return run(context, signal, async signal => {
            const item = await store(context); current(context, item, id); aborted(signal); return references.analyze(context, id);
        }); },
        unregister(context, id, input, signal) { return run(context, signal, async signal => {
            object(input, ['operationId', 'metadataRevision', 'sourceRevision'], ['operationId', 'metadataRevision', 'sourceRevision']);
            uuid(input.operationId); integer(input.metadataRevision); integer(input.sourceRevision);
            const item = await store(context), hash = item.requestHash(['unregister', id, input.metadataRevision, input.sourceRevision]);
            return coordinate(context, async () => {
                const replay = item.operation(input.operationId, now());
                if (!replay) { const row = current(context, item, id);
                    if (row.metadata_revision !== input.metadataRevision || row.source_revision !== input.sourceRevision) fail('VIDEO_METADATA_CONFLICT');
                    await references.requireUnused(context, id); }
                aborted(signal);
                const result = item.command(input.operationId, hash, now(), () => {
                    item.db.prepare('DELETE FROM progress WHERE video_id=?').run(id);
                    item.db.prepare('DELETE FROM receipts WHERE video_id=?').run(id);
                    item.db.prepare('DELETE FROM videos WHERE id=?').run(id); return { removed: true };
                });
                cancelStreams(context, id); return result;
            });
        }); },
        source(context, id, input, signal) { return run(context, signal, async signal => {
            object(input, ['operationId', 'sourceRevision', 'candidateId'], ['operationId', 'sourceRevision', 'candidateId']);
            uuid(input.operationId); integer(input.sourceRevision); uuid(input.candidateId);
            const item = await store(context), hash = item.requestHash(['source', id, input.sourceRevision, input.candidateId]);
            // Replay before looking up the ephemeral candidate, including after navigation/expiry.
            const replay = item.operation(input.operationId, now());
            if (replay) { current(context, item, id); return item.command(input.operationId, hash, now(), () => fail('INVALID_REQUEST')); }
            current(context, item, id);
            const { session, entry } = discovery.candidate(context, input.candidateId);
            const file = await openVideo(policy, context, session.rootKey, entry.relative, entry.fingerprint, signal);
            try { return await coordinate(context, () => {
                aborted(signal); const row = current(context, item, id);
                const result = item.command(input.operationId, hash, now(), () => {
                    if (row.source_revision !== input.sourceRevision) fail('VIDEO_SOURCE_CHANGED');
                    const duplicate = item.db.prepare('SELECT id FROM videos WHERE root_key=? AND locator=? AND id<>?').get(session.rootKey, entry.relative, id);
                    if (duplicate) fail('VIDEO_SOURCE_REGISTERED');
                    item.db.prepare('UPDATE videos SET root_key=?,locator=?,fingerprint=?,mime=?,byte_size=?,source_revision=source_revision+1 WHERE id=?')
                        .run(session.rootKey, entry.relative, file.fingerprint, file.mime, file.byteSize, id);
                    item.db.prepare('DELETE FROM progress WHERE video_id=?').run(id);
                    return item.view(item.row(id));
                });
                cancelStreams(context, id); return result;
            }); } finally { await file.handle.close(); }
        }); },
    };
}
