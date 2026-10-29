/** Exact role details document bytes use name then description, as in the original host. */
export function buildRoleMetadata(input: { name: string; description: string }): { name: string; description: string } {
  if (typeof input.name !== 'string' || typeof input.description !== 'string') throw new Error('INVALID_ROLE_METADATA');
  return { name: input.name, description: input.description };
}
