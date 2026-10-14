/** Interoperable folders/1. Array order and compatible extension fields survive serialization. */
export const FOLDERS_SCHEMA_VERSION = 1;
export interface FolderRecord {
  id: string; name: string; parentId: string | null; sortOrder: number; projectIds: string[];
  [key: string]: unknown;
}
export interface FolderDocument { schemaVersion: 1; folders: FolderRecord[]; [key: string]: unknown }
export function makeEmptyFolderDoc(): FolderDocument { return { schemaVersion: 1, folders: [] }; }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function projectKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/^0x[\da-fA-F]{64}$/.test(value)) return value.toLowerCase();
  const match = /^(0x[\da-fA-F]{40})-(0x[\da-fA-F]{64}|\d+)$/.exec(value);
  if (!match) return null;
  const id = BigInt(match[2]);
  if (id >= (1n << 256n)) return null;
  return match[1].toLowerCase() + '-' + id.toString();
}
export function validateFolderDoc(doc: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!object(doc)) return { valid: false, errors: ['Document is not an object.'] };
  if (doc.schemaVersion !== FOLDERS_SCHEMA_VERSION) errors.push('Unsupported schemaVersion.');
  if (!Array.isArray(doc.folders)) return { valid: false, errors: [...errors, '`folders` must be an array.'] };
  const byId = new Map<string, Record<string, unknown>>();
  const projects = new Set<string>();
  for (const f of doc.folders) {
    if (!object(f) || typeof f.id !== 'string' || !f.id) { errors.push('Folder requires a string id.'); continue; }
    if (byId.has(f.id)) errors.push('Duplicate folder id: ' + f.id);
    byId.set(f.id, f);
    if (typeof f.name !== 'string') errors.push('Folder name must be a string: ' + f.id);
    if (f.parentId !== null && (typeof f.parentId !== 'string' || !f.parentId)) errors.push('Invalid parentId: ' + f.id);
    if (typeof f.sortOrder !== 'number' || !Number.isFinite(f.sortOrder)) errors.push('sortOrder must be finite: ' + f.id);
    if (!Array.isArray(f.projectIds)) { errors.push('projectIds must be an array: ' + f.id); continue; }
    for (const pid of f.projectIds) {
      const key = projectKey(pid);
      if (!key) errors.push('Invalid project ID: ' + String(pid));
      else if (projects.has(key)) errors.push('Duplicate project assignment: ' + String(pid));
      else projects.add(key);
    }
  }
  // Iterative traversal also handles very deep valid trees without recursion overflow.
  const visited = new Set<string>();
  for (const [id, f] of byId) {
    if (f.parentId !== null && !byId.has(String(f.parentId))) errors.push('Unknown parent: ' + id);
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && byId.has(current) && !visited.has(current)) {
      if (path.has(current)) { errors.push('Folder tree contains a cycle.'); break; }
      path.add(current);
      const parent: unknown = byId.get(current)!.parentId;
      current = typeof parent === 'string' ? parent : null;
    }
    for (const key of path) visited.add(key);
  }
  return { valid: errors.length === 0, errors };
}
export function serializeFolderDoc(doc: FolderDocument): string {
  const result = validateFolderDoc(doc);
  if (!result.valid) throw new Error(result.errors.join(' '));
  return JSON.stringify(doc);
}
