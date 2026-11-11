/** A session id for transcript tests. */
export const ID = '0b9a3c52-6f1e-4c4e-9a63-2d5f0e7b8c11';

/** An assistant line as Claude Code 2.1.319 writes it (fields Tacet reads, plus some it ignores). */
export function assistantLine(
  id: string,
  usage: { input?: number; created?: number; read?: number; output?: number },
  extra: { model?: string; sidechain?: boolean; sessionId?: string } = {},
): string {
  const sessionId = extra.sessionId ?? ID;
  return `${JSON.stringify({
    type: 'assistant',
    isSidechain: extra.sidechain ?? false,
    uuid: `u-${id}-${Math.random()}`,
    sessionId,
    message: {
      id,
      role: 'assistant',
      model: extra.model ?? 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: usage.input ?? 0,
        cache_creation_input_tokens: usage.created ?? 0,
        cache_read_input_tokens: usage.read ?? 0,
        output_tokens: usage.output ?? 0,
        service_tier: 'standard',
      },
    },
  })}\n`;
}
