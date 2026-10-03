// Audio-only reference/commit critical sections. Never hold this during a
// network download. All Source bindings and Asset deletion share this lock.
const queues = new Map();
export function coordinateAudio(root, action) {
    const previous = queues.get(root) || Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    const tail = result.catch(() => {});
    queues.set(root, tail);
    void tail.then(() => { if (queues.get(root) === tail) queues.delete(root); });
    return result;
}
