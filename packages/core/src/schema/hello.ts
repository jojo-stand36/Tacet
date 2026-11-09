import { z } from 'zod';
import { Id } from './common.js';

/** Tacet wire protocol major versions (ADR-003 §2). */
export const ProtocolVersion = z.number().int().positive();

const ClientInfo = z.object({ name: z.string().min(1), version: z.string().min(1) });
const Capabilities = z.record(z.string(), z.unknown()).default({});

const HelloBase = {
  protocolVersions: z.array(ProtocolVersion).min(1),
  clientInfo: ClientInfo,
  capabilities: Capabilities,
};

/**
 * Params of the `tacet/hello` request, the first frame on every socket (ADR-003 §3.6).
 * A Mini-conductor also sends a lightweight Agent Card.
 */
export const HelloParams = z.discriminatedUnion('role', [
  z.object({ role: z.literal('ui'), ...HelloBase }),
  z.object({ role: z.literal('cli'), ...HelloBase }),
  z.object({
    role: z.literal('mini'),
    ...HelloBase,
    repoId: z.string().min(1),
    repoPath: z.string().min(1),
    adapters: z.array(z.string().min(1)),
    miniVersion: z.string().min(1),
  }),
]);
export type HelloParams = z.infer<typeof HelloParams>;

/** Result of `tacet/hello`. */
export const HelloResult = z.object({
  protocolVersion: ProtocolVersion,
  serverInfo: ClientInfo,
  capabilities: Capabilities,
  sessionId: Id,
});
export type HelloResult = z.infer<typeof HelloResult>;
