import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// OpenMsg (docs/32 F3): the official Meta API screens take their colors from the theme tokens
// (`--primary*`, `--success*`, the status tokens) that brand.css and dark mode override. A color
// literal in one of their rules would ignore both, so every declaration in a rule whose selector
// names `meta-cloud` or `template-picker` must be free of hex, rgb()/rgba() and hsl()/hsla().

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const STYLESHEET_DIRS = ['pages', 'components'];
const FEATURE_SELECTOR = /meta-cloud|template-picker/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

interface Rule {
  selector: string;
  body: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Style rules with their declaration blocks, descending into @media / @supports / @container. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    let j = i;
    while (j < css.length && css[j] !== '{' && css[j] !== '}') j++;
    if (j >= css.length) break;
    if (css[j] === '}') {
      i = j + 1;
      continue;
    }
    const header = css.slice(i, j).trim();
    let depth = 1;
    let k = j + 1;
    while (k < css.length && depth) {
      if (css[k] === '{') depth++;
      else if (css[k] === '}') depth--;
      k++;
    }
    const body = css.slice(j + 1, k - 1);
    if (/^@media|^@supports|^@container/.test(header)) out.push(...rules(body));
    else if (header && !header.startsWith('@')) out.push({ selector: header, body });
    i = k;
  }
  return out;
}

function stylesheets(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.css')) files.push(path);
    }
  };
  for (const dir of STYLESHEET_DIRS) walk(join(SRC_DIR, dir));
  return files;
}

/** `selector { declaration }` for each feature declaration holding a color literal. */
function colorLiterals(css: string): string[] {
  return rules(stripComments(css))
    .filter(rule => FEATURE_SELECTOR.test(rule.selector))
    .flatMap(rule =>
      rule.body
        .split(';')
        .map(declaration => declaration.trim())
        .filter(declaration => COLOR_LITERAL.test(declaration))
        .map(declaration => `${rule.selector.replace(/\s+/g, ' ')} { ${declaration} }`),
    );
}

test('C45 the detector flags each color literal form inside a feature rule and nothing outside one', () => {
  const css = `
    .x-page .meta-cloud-a { color: #fff; }
    .x-page .template-picker-b { background: rgba(0, 0, 0, 0.1); }
    @media (max-width: 640px) { .x-page .meta-cloud-c { border-color: hsl(10 20% 30%); } }
    .x-page .meta-cloud-d { color: var(--primary); }
    .x-page .other { color: #000; }
  `;
  assert.equal(colorLiterals(css).length, 3);
});

test('C45 no declaration in a meta-cloud or template-picker rule holds a hex, rgb() or hsl() color literal', () => {
  const found: string[] = [];
  let featureRules = 0;
  for (const file of stylesheets()) {
    const css = readFileSync(file, 'utf8');
    featureRules += rules(stripComments(css)).filter(rule => FEATURE_SELECTOR.test(rule.selector)).length;
    found.push(...colorLiterals(css).map(hit => `${file.slice(SRC_DIR.length + 1)}: ${hit}`));
  }
  assert.ok(featureRules > 0, 'no meta-cloud or template-picker rule was found (parse error?)');
  assert.deepEqual(
    found,
    [],
    `color literals in the official Meta API styles; use the theme tokens:\n  ${found.join('\n  ')}`,
  );
});
