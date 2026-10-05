import path from 'node:path';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { coordinateAudio } from '../audio-assets/coordination.js';
import { validAssetId } from '../audio-assets/store.js';

export class AudioLibraryFailure extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
const fail = (code) => {
    throw new AudioLibraryFailure(code);
};
export const validCategoryId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id);
export const validRevision = (n) => Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER;
export const validText = (s, max) =>
    typeof s === 'string' && s === s.trim() && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
const defaultTrack = (id) => ({
    asset_id: id,
    title: '',
    title_source: 'none',
    category_id: null,
    visibility: 'visible',
    revision: 0,
});
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const fields = (value, keys) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.sort().join(',');

export class AudioLibraryStore {
    constructor(userRoot, DatabaseSync) {
        this.root = path.join(userRoot, 'tavern-toolbox-server', 'audio-library-v1');
        this.DatabaseSync = DatabaseSync;
    }
    async initialize() {
        for (const dir of [path.dirname(this.root), this.root]) {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const info = await lstat(dir);
            if (!info.isDirectory() || info.isSymbolicLink()) fail('AUDIO_LIBRARY_DATA_INVALID');
            await chmod(dir, 0o700);
        }
        const file = path.join(this.root, 'library.sqlite');
        try {
            if ((await lstat(file)).isSymbolicLink()) fail('AUDIO_LIBRARY_DATA_INVALID');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const db = new this.DatabaseSync(file);
        try {
            await chmod(file, 0o600);
            db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;');
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version > 1) fail('AUDIO_LIBRARY_SCHEMA_INCOMPATIBLE');
            if (version === 0) {
                if (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                        )
                        .get().n
                )
                    fail('AUDIO_LIBRARY_DATA_INVALID');
                db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE tracks (asset_id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, title_source TEXT NOT NULL,
                        category_id TEXT, visibility TEXT NOT NULL, revision INTEGER NOT NULL);
                    CREATE TABLE categories (category_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE);
                    CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
                    INSERT INTO state VALUES (1, 0); PRAGMA user_version=1; COMMIT;`);
            }
            this.db = db;
            this.categories();
            this.metadata();
        } catch (error) {
            db.close();
            throw error;
        }
    }
    categories() {
        const revision = this.db.prepare('SELECT revision FROM state WHERE id=1').get()?.revision;
        const items = this.db.prepare('SELECT * FROM categories ORDER BY category_id').all();
        if (
            !validRevision(revision) ||
            items.length > 128 ||
            items.some((row) => !validCategoryId(row.category_id) || !validText(row.name, 60))
        )
            fail('AUDIO_LIBRARY_DATA_INVALID');
        return {
            revision,
            categories: items
                .map((row) => ({ categoryId: row.category_id, name: row.name }))
                .sort((a, b) => collator.compare(a.name, b.name) || a.categoryId.localeCompare(b.categoryId)),
        };
    }
    metadata() {
        const categories = new Set(this.categories().categories.map((item) => item.categoryId));
        const rows = this.db.prepare('SELECT * FROM tracks').all();
        if (
            rows.length > 4096 ||
            rows.some(
                (row) =>
                    !validAssetId(row.asset_id) ||
                    !validRevision(row.revision) ||
                    !['none', 'automatic', 'user'].includes(row.title_source) ||
                    (row.title_source === 'none' && row.title !== '') ||
                    (row.title_source !== 'none' && !validText(row.title, 120)) ||
                    !['visible', 'hidden'].includes(row.visibility) ||
                    (row.category_id !== null && !categories.has(row.category_id)),
            )
        )
            fail('AUDIO_LIBRARY_DATA_INVALID');
        return new Map(rows.map((row) => [row.asset_id, row]));
    }
    track(id) {
        return this.metadata().get(id) || defaultTrack(id);
    }
    view(row) {
        return {
            assetId: row.asset_id,
            displayTitle: row.title || '未命名音频',
            titleSource: row.title_source,
            category: row.category_id,
            libraryVisibility: row.visibility,
            revision: row.revision,
        };
    }
    write(row) {
        this.db
            .prepare('INSERT OR REPLACE INTO tracks VALUES (?, ?, ?, ?, ?, ?)')
            .run(row.asset_id, row.title, row.title_source, row.category_id, row.visibility, row.revision);
    }
    transaction(action) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = action();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    update(id, value) {
        if (
            !fields(value, ['revision', 'displayTitle', 'category', 'libraryVisibility']) ||
            !validRevision(value.revision) ||
            !validText(value.displayTitle, 120) ||
            (value.category !== null && !validCategoryId(value.category)) ||
            !['visible', 'hidden'].includes(value.libraryVisibility)
        )
            fail('INVALID_REQUEST');
        return this.transaction(() => {
            const row = this.track(id);
            if (row.revision !== value.revision) fail('AUDIO_LIBRARY_CONFLICT');
            if (
                value.category !== null &&
                !this.categories().categories.some((item) => item.categoryId === value.category)
            )
                fail('AUDIO_CATEGORY_NOT_FOUND');
            // Changing category/visibility must not turn an inferred title into a user title.
            const renamed = value.displayTitle !== this.view(row).displayTitle;
            const next = {
                ...row,
                title: renamed ? value.displayTitle : row.title,
                title_source: renamed ? 'user' : row.title_source,
                category_id: value.category,
                visibility: value.libraryVisibility,
                revision: row.revision + 1,
            };
            this.write(next);
            return this.view(next);
        });
    }
    observe(id, title) {
        if (!validText(title, 120)) fail('INVALID_REQUEST');
        return this.transaction(() => {
            const row = this.track(id);
            if (row.title_source !== 'none') return this.view(row);
            const next = { ...row, title, title_source: 'automatic', revision: row.revision + 1 };
            this.write(next);
            return this.view(next);
        });
    }
    mutateCategory(value) {
        const keys =
            value.operation === 'create'
                ? ['operation', 'revision', 'name']
                : value.operation === 'rename'
                  ? ['operation', 'revision', 'name', 'categoryId']
                  : ['operation', 'revision', 'categoryId'];
        if (
            !['create', 'rename', 'delete'].includes(value.operation) ||
            !fields(value, keys) ||
            !validRevision(value.revision) ||
            (value.operation !== 'delete' && !validText(value.name, 60)) ||
            (value.operation !== 'create' && !validCategoryId(value.categoryId))
        )
            fail('INVALID_REQUEST');
        return this.transaction(() => {
            const current = this.categories();
            if (current.revision !== value.revision) fail('AUDIO_LIBRARY_CONFLICT');
            if (
                value.operation !== 'create' &&
                !current.categories.some((item) => item.categoryId === value.categoryId)
            )
                fail('AUDIO_CATEGORY_NOT_FOUND');
            if (
                value.operation !== 'delete' &&
                current.categories.some(
                    (item) =>
                        item.name.toLocaleLowerCase() === value.name.toLocaleLowerCase() &&
                        item.categoryId !== value.categoryId,
                )
            )
                fail('AUDIO_CATEGORY_EXISTS');
            if (value.operation === 'create') {
                if (current.categories.length >= 128) fail('AUDIO_CATEGORIES_FULL');
                this.db
                    .prepare('INSERT INTO categories VALUES (?,?)')
                    .run(randomBytes(16).toString('base64url'), value.name);
            } else if (value.operation === 'rename')
                this.db.prepare('UPDATE categories SET name=? WHERE category_id=?').run(value.name, value.categoryId);
            else {
                this.metadata();
                this.db
                    .prepare('UPDATE tracks SET category_id=NULL, revision=revision+1 WHERE category_id=?')
                    .run(value.categoryId);
                this.db.prepare('DELETE FROM categories WHERE category_id=?').run(value.categoryId);
            }
            this.db.prepare('UPDATE state SET revision=revision+1 WHERE id=1').run();
            return this.categories();
        });
    }
    remove(id) {
        this.db.prepare('DELETE FROM tracks WHERE asset_id=?').run(id);
    }
    close() {
        this.db.close();
    }
}

export function createAudioLibrary(config, assets) {
    const stores = new Map();
    let DatabaseSync,
        stopped = false;
    async function store(context) {
        if (stopped || !DatabaseSync || !context?.userRoot) fail('AUDIO_LIBRARY_UNAVAILABLE');
        if (!stores.has(context.userRoot))
            stores.set(
                context.userRoot,
                (async () => {
                    const item = new AudioLibraryStore(context.userRoot, DatabaseSync);
                    await item.initialize();
                    return item;
                })(),
            );
        try {
            return await stores.get(context.userRoot);
        } catch (error) {
            stores.delete(context.userRoot);
            throw error;
        }
    }
    // Product metadata is not an Asset reference. Foundation only emits a deletion event.
    const unobserve = assets.onDelete(async (context, id) => {
        try {
            const item = await store(context);
            item.remove(id);
        } catch {
            /* List recovery prunes dangling metadata; never block Foundation deletion. */
        }
    });
    async function ready(context) {
        return [await store(context), await assets.store(context)];
    }
    const mutations = ['update', 'observe', 'category'];
    return {
        definition: {
            id: 'audio-library',
            version: '0.1.0',
            dependsOn: ['core', 'audio-assets'],
            capabilities: [
                {
                    id: 'audio.library',
                    contract: { major: 1, minMinor: 0, maxMinor: 0 },
                    operations: ['list', 'read', 'categories', ...mutations].map((id) => ({ id, available: true })),
                    operationAvailability: () =>
                        Object.fromEntries(
                            mutations.map((id) => [
                                id,
                                {
                                    available: config.policy.core.allowedOrigins.length > 0,
                                    reasonCode: 'ORIGIN_POLICY_MISSING',
                                },
                            ]),
                        ),
                    limits: {
                        pageSize: 50,
                        maxAssets: 4096,
                        maxCategories: 128,
                        maxTitleLength: 120,
                        maxCategoryLength: 60,
                    },
                    constraints: {
                        scope: 'st-user',
                        persistence: 'sqlite',
                        identity: 'audio-asset',
                        retentionLock: false,
                        playback: 'local-only',
                        updates: 'revision-cas',
                    },
                },
            ],
            initialize: async () => {
                ({ DatabaseSync } = await import('node:sqlite'));
            },
            health: async (context) => {
                try {
                    await ready(context);
                    return { state: 'ready', reasonCode: null };
                } catch (error) {
                    return {
                        state: 'unavailable',
                        reasonCode: error instanceof AudioLibraryFailure ? error.code : 'AUDIO_LIBRARY_UNAVAILABLE',
                    };
                }
            },
            shutdown: async () => {
                stopped = true;
                unobserve();
                for (const pending of stores.values()) {
                    try {
                        (await pending).close();
                    } catch {}
                }
                stores.clear();
            },
        },
        async categories(context) {
            return (await store(context)).categories();
        },
        async category(context, value) {
            const item = await store(context);
            return coordinateAudio(context.userRoot, () => item.mutateCategory(value));
        },
        async read(context, id) {
            const [item, assetStore] = await ready(context);
            return coordinateAudio(context.userRoot, async () => ({
                ...item.view(item.track(assetStore.get(id).asset_id)),
                health: await assetStore.quick(assetStore.get(id)),
            }));
        },
        async update(context, id, value) {
            const [item, assetStore] = await ready(context);
            return coordinateAudio(context.userRoot, () => {
                assetStore.get(id);
                return item.update(id, value);
            });
        },
        async observe(context, id, title) {
            const [item, assetStore] = await ready(context);
            return coordinateAudio(context.userRoot, () => {
                assetStore.get(id);
                return item.observe(id, title);
            });
        },
        async list(context, query = {}) {
            if (
                Object.keys(query).some((key) => !['category', 'search', 'hidden', 'cursor'].includes(key)) ||
                Object.values(query).some((value) => typeof value !== 'string') ||
                (query.category &&
                    !['all', 'uncategorized'].includes(query.category) &&
                    !validCategoryId(query.category)) ||
                (query.search && query.search.length > 120) ||
                (query.hidden && !['true', 'false'].includes(query.hidden)) ||
                (query.cursor && !/^\d{1,4}~[a-f0-9]{16}$/.test(query.cursor))
            )
                fail('INVALID_REQUEST');
            const [item, assetStore] = await ready(context);
            return coordinateAudio(context.userRoot, async () => {
                const metadata = item.metadata(),
                    cats = item.categories();
                if (
                    query.category &&
                    !['all', 'uncategorized'].includes(query.category) &&
                    !cats.categories.some((c) => c.categoryId === query.category)
                )
                    fail('AUDIO_CATEGORY_NOT_FOUND');
                const records = await assetStore.inventory();
                const all = records.map((row) => ({
                    ...row,
                    ...item.view(metadata.get(row.assetId) || defaultTrack(row.assetId)),
                }));
                // Recover harmless dangling metadata after interrupted deletion. Never retain an Asset.
                const ids = new Set(records.map((row) => row.assetId));
                for (const id of metadata.keys()) if (!ids.has(id)) item.remove(id);
                const selected = all
                    .filter(
                        (row) =>
                            query.hidden === 'true' || (row.health === 'healthy' && row.libraryVisibility !== 'hidden'),
                    )
                    .filter(
                        (row) =>
                            !query.category ||
                            query.category === 'all' ||
                            row.category === (query.category === 'uncategorized' ? null : query.category),
                    )
                    .filter(
                        (row) =>
                            !query.search ||
                            row.displayTitle.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()),
                    )
                    .sort(
                        (a, b) =>
                            collator.compare(a.displayTitle, b.displayTitle) ||
                            a.assetId.localeCompare(b.assetId, 'en'),
                    );
                const snapshot = createHash('sha256')
                    .update(
                        JSON.stringify([
                            cats,
                            query.category || 'all',
                            query.search || '',
                            query.hidden || 'false',
                            selected,
                        ]),
                    )
                    .digest('hex')
                    .slice(0, 16);
                let offset = 0;
                if (query.cursor) {
                    const [position, stamp] = query.cursor.split('~');
                    if (stamp !== snapshot) fail('AUDIO_LIBRARY_CONFLICT');
                    offset = Number(position);
                    if (offset >= selected.length) fail('INVALID_REQUEST');
                }
                return {
                    items: selected.slice(offset, offset + 50),
                    total: selected.length,
                    nextCursor: offset + 50 < selected.length ? `${offset + 50}~${snapshot}` : null,
                    snapshot,
                    ...cats,
                };
            });
        },
    };
}
