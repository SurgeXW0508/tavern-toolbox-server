import { DocumentFailure } from './validation.js';

export const OUTFIT_LIMITS = Object.freeze({ maxPromptChars: 8000, maxPresetBytes: 96 * 1024,
    maxPresets: 128, maxDocumentBytes: 1024 * 1024 });
const builtins = new Set(['balanced', 'first-reveal', 'subtle', 'state-first']);
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => plain(v) && Object.keys(v).sort().join(',') === expected.split(',').sort().join(',');
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim();
const id = v => text(v, 100) && /^[a-zA-Z0-9:_-]+$/.test(v);

// This consumer owns payload semantics. The public store never understands prompts.
export function validateOutfitSettings(p) {
    const invalid = () => { throw new DocumentFailure('DOCUMENT_INVALID'); };
    if (!keys(p, 'settingsVersion,injectionEnabled,injectionPosition,activeNarrativePresetId,customNarrativePresets')
        || p.settingsVersion !== 5 || typeof p.injectionEnabled !== 'boolean'
        || !['compatibility', 'balanced', 'constraint'].includes(p.injectionPosition)
        || !id(p.activeNarrativePresetId) || !Array.isArray(p.customNarrativePresets)
        || p.customNarrativePresets.length > OUTFIT_LIMITS.maxPresets) invalid();
    const ids = new Set(builtins);
    for (const preset of p.customNarrativePresets) {
        if (!keys(preset, 'id,name,protocols,builtin') || !id(preset.id) || ids.has(preset.id)
            || !text(preset.name, 80) || preset.builtin !== false || !keys(preset.protocols, 'fixed,scene,mixed')
            || !['fixed', 'scene', 'mixed'].every(mode => text(preset.protocols[mode], OUTFIT_LIMITS.maxPromptChars))
            || Buffer.byteLength(JSON.stringify(preset)) > OUTFIT_LIMITS.maxPresetBytes) invalid();
        ids.add(preset.id);
    }
    // An obsolete active ID is retained on the wire; frontend owns builtin fallback.
    return p;
}

export const outfitSettingsConsumer = Object.freeze({ id: 'outfit-settings', schemaVersion: 1,
    maxBytes: OUTFIT_LIMITS.maxDocumentBytes, limits: OUTFIT_LIMITS, validate: validateOutfitSettings });
