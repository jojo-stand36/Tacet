/**
 * `@tacet/mini/workers`: builds Worker adapters from the effective config (#149). A separate
 * entry, so the daemon itself never imports the adapter packages.
 */
export {
  type BuildWorkerAdaptersOptions,
  buildWorkerAdapters,
  WorkerConfigError,
} from './build.js';
