/**
 * Environment injection seam.
 *
 * @poa-box/core never reads process.env. Hosts pass an EnvSource where env-derived
 * behavior is wanted: the CLI passes process.env, a Next.js frontend passes an
 * object built from NEXT_PUBLIC_* values, tests pass literals, and integrators
 * who want pure defaults pass nothing.
 */
export type EnvSource = Record<string, string | undefined>;

export const EMPTY_ENV: EnvSource = {};
