/**
 * Education module metadata document.
 *
 * KEY ORDER IS A PROTOCOL CONTRACT: {name, description, link, quiz, answers}
 * MUST match the frontend for subgraph/UI compatibility. Both education
 * writers pin this exact shape:
 *   - `pop education create` — src/commands/education/create-module.ts
 *   - `pop education update` — src/commands/education/update.ts (re-pin path)
 */

export interface EducationModuleMetadata {
  name: string;
  description: string;
  link: string;
  quiz: string[];
  answers: string[][];
}

/**
 * Port of the metadata document `pop education create` /
 * `pop education update` pin — key order is load-bearing:
 * name, description, link, quiz, answers.
 */
export function buildEducationModuleMetadata(params: {
  name: string;
  description?: string;
  link?: string;
  quiz?: string[];
  answers?: string[][];
}): EducationModuleMetadata {
  return {
    name: params.name,
    description: params.description || '',
    link: params.link || '',
    quiz: params.quiz || [],
    answers: params.answers || [],
  };
}

/** Exact serialization the CLI pins (plain JSON.stringify). */
export function serializeEducationModuleMetadata(metadata: EducationModuleMetadata): string {
  return JSON.stringify(metadata);
}
