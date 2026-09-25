const ID = /^[a-z][a-z0-9.-]*$/;
const STATES = new Set(['ready', 'degraded', 'unavailable', 'disabled', 'initializing', 'stopping']);
function bounded(call, milliseconds) {
    let timer;
    return Promise.race([Promise.resolve().then(call), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIME_BUDGET_EXCEEDED')), milliseconds);
    })]).finally(() => clearTimeout(timer));
}

// Internal registration only. The server never loads modules supplied by the browser.
export class CapabilityRegistry {
    #definitions = new Map();
    #errors = new Map();
    #states = new Map();
    #sealed = false;

    register(definition) {
        if (this.#sealed) throw new Error('REGISTRY_SEALED');
        if (!definition || !ID.test(definition.id || '') || typeof definition.version !== 'string'
            || !Array.isArray(definition.dependsOn || []) || !Array.isArray(definition.capabilities || [])) throw new Error('INVALID_MODULE');
        if (this.#definitions.has(definition.id)) {
            this.#errors.set(definition.id, 'DUPLICATE_MODULE_ID');
            return;
        }
        this.#definitions.set(definition.id, definition);
    }

    async initialize() {
        if (this.#sealed) throw new Error('REGISTRY_SEALED');
        this.#sealed = true;
        const owners = new Map();
        for (const [id, module] of this.#definitions) {
            for (const capability of module.capabilities) {
                if (!capability || !ID.test(capability.id || '') || !capability.contract
                    || capability.contract.major !== 1 || !Array.isArray(capability.operations)) {
                    this.#errors.set(id, 'INVALID_CAPABILITY');
                    continue;
                }
                const owner = owners.get(capability.id);
                if (owner) { this.#errors.set(id, 'DUPLICATE_CAPABILITY'); this.#errors.set(owner, 'DUPLICATE_CAPABILITY'); }
                else owners.set(capability.id, id);
            }
        }
        const pending = new Set(this.#definitions.keys());
        while (pending.size) {
            let progressed = false;
            for (const id of [...pending]) {
                const module = this.#definitions.get(id);
                if (module.dependsOn?.some(dep => pending.has(dep))) continue;
                pending.delete(id);
                progressed = true;
                const dependencyFailed = module.dependsOn?.some(dep => !this.#definitions.has(dep) || this.#states.get(dep)?.state !== 'ready');
                const reasonCode = this.#errors.get(id) || (dependencyFailed ? 'DEPENDENCY_UNAVAILABLE' : null);
                if (reasonCode) { this.#states.set(id, { state: 'unavailable', reasonCode }); continue; }
                try { await bounded(() => module.initialize?.(), 3000); this.#states.set(id, { state: 'ready', reasonCode: null }); }
                catch { this.#states.set(id, { state: 'unavailable', reasonCode: 'MODULE_INITIALIZATION_FAILED' }); }
            }
            if (!progressed) {
                for (const id of pending) this.#states.set(id, { state: 'unavailable', reasonCode: 'DEPENDENCY_CYCLE' });
                break;
            }
        }
    }

    async snapshot(context) {
        const modules = [];
        const capabilities = [];
        for (const [id, module] of this.#definitions) {
            let { state, reasonCode } = this.#states.get(id) || { state: 'initializing', reasonCode: null };
            if (state === 'ready' && module.health) {
                try {
                    const health = await bounded(() => module.health(context), 250);
                    if (!health || !STATES.has(health.state)) throw new Error('invalid health');
                    state = health.state;
                    reasonCode = health.reasonCode || null;
                } catch { state = 'unavailable'; reasonCode = 'MODULE_HEALTH_FAILED'; }
            }
            modules.push({ id, version: module.version, state, reasonCode });
            for (const capability of module.capabilities) {
                if (!ID.test(capability?.id || '') || !capability?.contract || !Array.isArray(capability.operations)) continue;
                const available = state === 'ready' || state === 'degraded';
                capabilities.push({ id: capability.id, moduleId: id, contract: capability.contract,
                    state, reasonCode, operations: capability.operations.map(operation => ({
                        id: operation.id, available: available && operation.available !== false,
                        reasonCode: available && operation.available !== false ? null : reasonCode || operation.reasonCode || 'CAPABILITY_UNAVAILABLE',
                    })), limits: capability.limits || {}, constraints: capability.constraints || {} });
            }
        }
        return { modules, capabilities };
    }

    async shutdown() {
        for (const [id, module] of [...this.#definitions].reverse()) {
            if (this.#states.get(id)?.state === 'ready') {
                try { await module.shutdown?.(); } catch { /* exit cannot be relied upon for data correctness */ }
            }
            this.#states.set(id, { state: 'stopping', reasonCode: null });
        }
    }
}
