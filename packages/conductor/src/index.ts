/** Global Conductor daemon (#23): the registry of Mini-conductors; inbox, workflows and the UI API to come. */
export const packageName = '@tacet/conductor' as const;
export * from './conductor.js';
export { replicaDir } from './replicas.js';
