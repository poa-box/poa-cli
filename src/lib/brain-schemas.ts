/**
 * Brain doc schemas — Task #463 Stage 7 thin re-export wrapper.
 *
 * The validateBrainDocShape implementation lives in @unified-ai-brain/core
 * (extracted via Stages 1-6.5 of the brain-layer spinoff; see Task #449
 * vision doc). This file re-exports the canonical implementation so existing
 * call sites (`import { validateBrainDocShape } from './brain-schemas'`,
 * including the dynamic `await import('./brain-schemas')` calls in
 * src/lib/brain.ts) keep working unchanged.
 *
 * The pre-Stage-7 inline implementation is preserved at brain-schemas.ts.
 * preStage7-backup for reference + rollback during the dep-strategy
 * transition. Once @unified-ai-brain/core is npm-published (Stage 8) the
 * `file:` dep in package.json gets replaced with a versioned semver dep,
 * and the backup file can be deleted.
 *
 * Sync discipline: if poa-cli adds a new optional field to lessons (the
 * way Tasks #509 + #510 added causedBy + delegateTo), back-port the
 * validation to @unified-ai-brain/core/src/schemas.ts FIRST, then
 * release a new version + bump the dep here. Otherwise the upstream will
 * silently reject lessons with the new field as schema violations.
 */

export {
  validateBrainDocShape,
  type ValidationResult,
} from '@unified-ai-brain/core';
