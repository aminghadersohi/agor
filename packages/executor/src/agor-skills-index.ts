/**
 * The team skills index the daemon resolved for this task (`params.skillsIndex`).
 *
 * One executor process runs one task, so the index is set once at startup and
 * every harness appends it after the static Agor system prompt: Claude's
 * `systemPrompt.append`, Codex's `model_instructions_file`, Gemini's
 * `userMemory`. The static prompt stays byte-stable for provider prompt
 * caching; this block only changes when a session starts on a new release.
 */

/** Upper bound on what the executor will append; the daemon caps the index well below it. */
export const MAX_SKILLS_INDEX_CHARS = 16_000;

let skillsIndex: string | undefined;
let skillsEnabled = true;

export function setSkillLoadingEnabled(enabled: boolean): void {
  skillsEnabled = enabled;
  if (!enabled) skillsIndex = undefined;
}

export function isSkillLoadingEnabled(): boolean {
  return skillsEnabled;
}

export function setAgorSkillsIndex(text: string | undefined): void {
  const trimmed = skillsEnabled ? text?.trim() : undefined;
  skillsIndex = trimmed ? trimmed.slice(0, MAX_SKILLS_INDEX_CHARS) : undefined;
}

export function getAgorSkillsIndex(): string | undefined {
  return skillsIndex;
}

/** `systemPrompt` followed by the skills index, when this task has one. */
export function withAgorSkillsIndex(systemPrompt: string): string {
  return skillsIndex ? `${systemPrompt}\n\n${skillsIndex}` : systemPrompt;
}
