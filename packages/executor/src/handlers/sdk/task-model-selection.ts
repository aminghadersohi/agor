import type { KeyResolutionResult } from '@agor/core/config';
import { getCrossAgenticToolModelError } from '@agor/core/models';
import type { AgenticToolName, Session, SessionID } from '@agor/core/types';

/**
 * Guard the actual Session snapshot delivered to the SDK, not the earlier
 * credential-service read. Async configuration edits may occur between them.
 * Every reread is checked; detach model_config so later mutations cannot change
 * the validated selection. Other Session fields remain fresh (resume/MCP/etc.).
 * Install only after missing/decryption credential preflight has succeeded.
 */
export function guardTaskModelSelection(
  sessions: { findById(id: SessionID): Promise<Session | null> },
  sessionId: SessionID,
  tool: AgenticToolName,
  resolution: KeyResolutionResult
): void {
  const provider = {
    connection: { ...resolution.connection },
    useNativeAuth: resolution.useNativeAuth,
  };
  const findById = sessions.findById.bind(sessions);
  sessions.findById = async (id) => {
    const session = await findById(id);
    if (!session || id !== sessionId) return session;
    const modelConfig = session.model_config
      ? structuredClone(session.model_config)
      : session.model_config;
    const error = getCrossAgenticToolModelError(tool, modelConfig, provider);
    if (error) throw new Error(error);
    return { ...session, model_config: modelConfig };
  };
}
