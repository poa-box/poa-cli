import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('public passkey creation output composes with counterfactual prediction under strict TypeScript', () => {
  const fixture = fileURLToPath(new URL('./public-type-consumer.ts', import.meta.url));
  const program = ts.createProgram([fixture], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, esModuleInterop: true,
    skipLibCheck: false, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], types: ['node'] });
  const errors = ts.getPreEmitDiagnostics(program).map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  expect(errors).toEqual([]);
});
