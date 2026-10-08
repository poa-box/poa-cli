/** Empty collections cannot prove the item schema, but a missing collection is a breaking change. */
export function unobservableItemKeys(value: unknown, promised: string[]): string[] {
  if (Array.isArray(value)) return value.length === 0 ? promised.filter(key => key.startsWith('[].')) : [];
  if (!value || typeof value !== 'object') return [];
  return promised.filter(key => {
    const match = /^([^.[\]]+)\[\]\./.exec(key);
    if (!match) return false;
    const collection = (value as Record<string, unknown>)[match[1]];
    return Array.isArray(collection) && collection.length === 0;
  });
}
