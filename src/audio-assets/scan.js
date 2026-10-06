import { AudioAssetFailure } from './errors.js';

// Bounded filesystem fan-out; drain every worker before releasing the read owner.
export async function scanAudioRows(rows, action, signal) {
    let next = 0, error;
    const result = new Array(rows.length);
    const workers = Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (!error && next < rows.length) {
            if (signal?.aborted) { error = new AudioAssetFailure('CLIENT_ABORTED'); break; }
            const index = next++;
            try { result[index] = await action(rows[index]); } catch (failure) { error ||= failure; }
        }
    });
    await Promise.all(workers);
    if (signal?.aborted) error ||= new AudioAssetFailure('CLIENT_ABORTED');
    if (error) throw error;
    return result;
}
