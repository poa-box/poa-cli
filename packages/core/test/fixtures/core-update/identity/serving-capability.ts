import { parse, valueFromASTUntyped, visit } from 'graphql';

/** Portable planner boundary established by the retained two-source execution errors.
 * This checks actual where values (including variable-supplied filters), separately
 * from schema validity. Scalar module predicates do not count as child joins. */
export function assertServingCapabilities(document: string, variables: Record<string, unknown>): void {
  function inspect(value: unknown, joins = 0): void {
    if (Array.isArray(value)) { for (const item of value) inspect(item, joins); return; }
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      const depth = joins + (name.endsWith('_') ? 1 : 0);
      if (depth > 1) throw new Error(`Child filter nesting not supported by value \`${name.slice(0, -1)}\``);
      inspect(child, depth);
    }
  }
  visit(parse(document), { Argument(node) {
    if (node.name.value === 'where') inspect(valueFromASTUntyped(node.value, variables));
  } });
}
