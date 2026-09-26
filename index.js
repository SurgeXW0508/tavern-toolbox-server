import { createCore, PRODUCT } from './src/core.js';

export const info = {
    id: PRODUCT,
    name: 'Tavern Toolbox Server',
    description: 'Optional server capabilities for Tavern Toolbox.',
};

let core;
export async function init(router) {
    core = await createCore();
    core.attach(router);
}

export async function exit() {
    await core?.shutdown();
    core = null;
}
