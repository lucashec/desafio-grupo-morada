import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MATRIX = 'docs/specs/traceability.md';
const MARKER = /^\s*\/\/ (REQ-[A-Z]+-\d{2}(?:, REQ-[A-Z]+-\d{2})*)$/;
const TEST = /^\s*(?:it|test)(\.each)?\(/;
const errors = [];

const reqs = [...readFileSync('docs/specs/requirements.md', 'utf8').matchAll(/^### (REQ-[A-Z]+-\d{2}) \[(IMPLEMENTAR|PROPOSTA PRODUÇÃO)\]$/gm)]
  .map(([, id, kind]) => ({ id, kind, tests: [] }));
const byId = new Map(reqs.map((r) => [r.id, r]));

const files = readdirSync('test', { recursive: true }).filter((f) => f.endsWith('.test.ts')).map((f) => join('test', f)).sort();
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const test = TEST.exec(line);
    const marker = MARKER.exec(lines[i - 1] ?? '');
    if (test && !marker) errors.push(`${file}:${i + 1}: test without a // REQ-... marker on the line above`);
    if (MARKER.test(line) && !TEST.test(lines[i + 1] ?? '')) errors.push(`${file}:${i + 1}: marker not followed by it(/test(/it.each(/test.each(`);
    if (!test || !marker) return;
    const rest = lines.slice(i, i + 40).join('\n');
    const from = test[1] ? rest.indexOf(')(') + 2 : rest.indexOf('(') + 1;
    const name = /(['`])((?:\\.|(?!\1).)*)\1/.exec(rest.slice(from))?.[2] ?? '?';
    for (const id of marker[1].split(', ')) {
      const req = byId.get(id);
      if (req) req.tests.push(`${name.replaceAll('|', '\\|')} (\`${file}\`)`);
      else errors.push(`${file}:${i}: marker cites unknown ${id}`);
    }
  });
}

const rows = reqs.map((r) => {
  if (r.kind === 'IMPLEMENTAR' && r.tests.length === 0) errors.push(`${r.id}: [IMPLEMENTAR] requirement without a test`);
  const cell = r.tests.length ? r.tests.join('<br>') : r.kind === 'IMPLEMENTAR' ? '**SEM TESTE**' : 'proposta, sem teste';
  return `| ${r.id} | ${r.kind} | ${cell} |`;
});
const matrix = [
  '# Matriz de rastreabilidade',
  '',
  'Gerada por `npm run check:trace -- --write`. Não editar à mão.',
  '',
  '| Requisito | Tipo | Testes (arquivo) |',
  '|---|---|---|',
  ...rows,
  '',
].join('\n');

if (process.argv.includes('--write')) writeFileSync(MATRIX, matrix);
else if (!existsSync(MATRIX) || readFileSync(MATRIX, 'utf8') !== matrix) errors.push(`${MATRIX} is out of date: run npm run check:trace -- --write`);

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`check:trace ok: ${reqs.length} requirements, ${files.length} test files`);
