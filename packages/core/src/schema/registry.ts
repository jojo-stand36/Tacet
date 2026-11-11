import { z } from 'zod';
import { Id, openEnum } from './common.js';

/**
 * The Conductor's registry of Mini-conductors (`registry.*`, #23): the repos the user registered
 * for it to look after, and which Mini-conductors are connected. Local to the Conductor, which
 * forwards no events anywhere (ADR-003 addendum). Unlike other local events these carry a repo's
 * path: it is the user's own registration, kept in the user's own log.
 */

/** A repo id: the first 16 hex digits of the hash of its canonical path (`repoStatePaths`). */
export const RepoId = z.string().regex(/^[0-9a-f]{16}$/, 'expected a repo id');

/** Payload of `registry.repo_added`: the user registered a repo (`tacet up --add`). */
export const RegistryRepoAdded = z.object({
  repoId: RepoId,
  /** Absolute, canonical path of the repo's main checkout. */
  repoPath: z.string().min(1),
});
export type RegistryRepoAdded = z.infer<typeof RegistryRepoAdded>;

/** Payload of `registry.repo_removed`: the user removed a repo from the registry. */
export const RegistryRepoRemoved = z.object({ repoId: RepoId });
export type RegistryRepoRemoved = z.infer<typeof RegistryRepoRemoved>;

/** Payload of `registry.connected`: a Mini-conductor said hello. */
export const RegistryConnected = z.object({
  repoId: RepoId,
  repoPath: z.string().min(1),
  /** The connection's session id (the hello result's). */
  sessionId: Id,
  miniVersion: z.string().min(1),
  adapters: z.array(z.string().min(1)),
});
export type RegistryConnected = z.infer<typeof RegistryConnected>;

/**
 * Why a Mini-conductor's connection ended: it `closed`, it missed its pongs (`silent`), another
 * hello for the repo took over (`replaced`), or the Conductor restarted with it still recorded as
 * connected (`conductor_restart`). Unknown values read as `closed`.
 */
export const RegistryDisconnectReason = openEnum(
  ['closed', 'silent', 'replaced', 'conductor_restart'],
  'closed',
);
export type RegistryDisconnectReason = z.infer<typeof RegistryDisconnectReason>;

/** Payload of `registry.disconnected`. */
export const RegistryDisconnected = z.object({
  repoId: RepoId,
  sessionId: Id,
  reason: RegistryDisconnectReason,
});
export type RegistryDisconnected = z.infer<typeof RegistryDisconnected>;
