import { type TacetConfig, vendorOf } from '@tacet/core';

/**
 * Whether a Codex adapter may be the reviewer (#19). Off until it is verified that a Codex
 * session runs nothing in its sandbox without asking, so refusing every approval keeps it
 * read-only (docs/adapters/spikes/58-codex/README.md: unverified).
 */
export const REVIEW_WITH_CODEX = false;
const CODEX_ADAPTERS: ReadonlySet<string> = new Set(['codex-app-server', 'acp:codex-acp']);

/**
 * Why the review config cannot run (#19), or undefined when review is off or can run. With
 * `cross_vendor` (the default) the reviewer must run a known vendor's models, different from the
 * Worker's: set `tiers.<name>.vendor` for an adapter that can run any vendor's, or
 * `tiers.review.cross_vendor: false` to review with the same vendor.
 */
export function reviewConfigProblem(config: TacetConfig): string | undefined {
  if (!config.review?.enabled) return undefined;
  const review = config.tiers?.review;
  const worker = config.tiers?.worker;
  if (!review) return 'review.enabled: review needs a tiers.review to run the reviewer';
  if (CODEX_ADAPTERS.has(review.adapter) && !REVIEW_WITH_CODEX) {
    return `tiers.review.adapter: ${review.adapter} cannot review yet: whether it stays read-only is unverified`;
  }
  if (review.adapter.startsWith('pty:')) {
    return `tiers.review.adapter: ${review.adapter} cannot have its tools refused, so it cannot review`;
  }
  if (review.cross_vendor === false || !worker) return undefined;
  const rv = vendorOf(review.adapter, review);
  const wv = vendorOf(worker.adapter, worker);
  if (rv === undefined) {
    return `tiers.review.vendor: say whose models ${review.adapter} runs, or set tiers.review.cross_vendor: false`;
  }
  if (wv === undefined) {
    return `tiers.worker.vendor: say whose models ${worker.adapter} runs, or set tiers.review.cross_vendor: false`;
  }
  if (rv === wv) {
    return `tiers.review: the reviewer runs ${rv} models like the Worker; pick another vendor's adapter or set tiers.review.cross_vendor: false`;
  }
  return undefined;
}
