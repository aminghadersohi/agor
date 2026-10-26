import type { KeyResolutionResult } from '@agor/core/config';
import { getCrossAgenticToolModelError } from '@agor/core/models';
import type { AgenticToolName, Session, SessionID } from '@agor/core/types';

/**
 * Guard the actual Session snapshot delivered to the SDK, not the earlier
 * credential-service read. Async configuration edits may occur between them.
 * Bind the first target read for this Task; later model edits belong to the next
 * prompt, not active-turn persistence/existence checks. Each read gets a detached
 * copy of the bound selection; other fields stay fresh (resume/MCP/deletion).
 * The ephemeral executor creates a new repository/guard for every Task.
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
  let bound = false;
  let selectedModel: Session['model_config'];
  const findById = sessions.findById.bind(sessions);
  sessions.findById = async (id) => {
    const session = await findById(id);
    if (!session || id !== sessionId) return session;
    if (!bound) {
      const modelConfig = session.model_config
        ? structuredClone(session.model_config)
        : session.model_config;
      const error = getCrossAgenticToolModelError(tool, modelConfig, provider);
      if (error) throw new Error(error);
      selectedModel = modelConfig;
      bound = true;
    }
    return {
      ...session,
      model_config: selectedModel ? structuredClone(selectedModel) : selectedModel,
    };
  };
}
