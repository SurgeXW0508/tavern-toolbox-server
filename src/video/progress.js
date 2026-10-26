import { object, integer, uuid, fail } from './validation.js';

export function readProgress(store, video) {
    const row = store.db.prepare('SELECT * FROM progress WHERE video_id=?').get(video.id);
    if (!row || row.source_revision !== video.source_revision) return { sourceRevision: video.source_revision, revision: 0,
        positionSeconds: 0, durationHint: 0, completed: false, writeId: null, updatedAt: null };
    return { sourceRevision: row.source_revision, revision: row.revision, positionSeconds: row.position,
        durationHint: row.duration, completed: Boolean(row.completed), writeId: row.write_id, updatedAt: row.updated_at };
}
export function writeProgress(store, video, input, now) {
    object(input, ['sourceRevision', 'expectedProgressRevision', 'writeId', 'positionSeconds', 'durationHint', 'completed'],
        ['sourceRevision', 'expectedProgressRevision', 'writeId', 'positionSeconds', 'durationHint', 'completed']);
    integer(input.sourceRevision); integer(input.expectedProgressRevision, 0); uuid(input.writeId);
    for (const key of ['positionSeconds', 'durationHint']) if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 7 * 86400) fail('INVALID_REQUEST');
    if (typeof input.completed !== 'boolean') fail('INVALID_REQUEST');
    if (video.source_revision !== input.sourceRevision) fail('VIDEO_SOURCE_CHANGED');
    const hash = store.requestHash(['progress', video.id, input.sourceRevision, input.expectedProgressRevision,
        input.positionSeconds, input.durationHint, input.completed]);
    return store.command(input.writeId, hash, now, () => {
        if (video.source_revision !== input.sourceRevision) fail('VIDEO_SOURCE_CHANGED');
        const current = readProgress(store, video);
        if (current.revision !== input.expectedProgressRevision) fail('VIDEO_PROGRESS_CONFLICT');
        store.db.prepare('INSERT OR REPLACE INTO progress VALUES(?,?,?,?,?,?,?,?)').run(video.id, video.source_revision,
            input.positionSeconds, input.durationHint, Number(input.completed), current.revision + 1, input.writeId, now);
        return readProgress(store, video);
    });
}
