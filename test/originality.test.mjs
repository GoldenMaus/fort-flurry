// SPEC section 0: Fort Flurry's name, characters and text are all its own. This walks every
// shipped file and fails on any banned string, so nobody can sneak one in by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BANNED = [
  'Snowbrawl', 'Snow Brawl', 'brawl', 'Blackeye', 'Snowpack', 'Snowcraft', 'Brian', 'snowplow', 'snow plow',
  'snow day', 'Frosty', 'Olaf', 'Elsa', 'Sven', 'Bumble', 'Hobbes', 'Let It Go', 'build a snowman', 'Winter is coming',
];

// Case-insensitive and whole-word, with any run of whitespace standing in for a space, so a
// phrase wrapped across two source lines is still caught.
function matcherFor(phrase) {
  const body = phrase.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(`\\b${body}\\b`, 'i');
}

const MATCHERS = BANNED.map((phrase) => ({ phrase, regex: matcherFor(phrase) }));

function hitsIn(text) {
  return MATCHERS.filter(({ regex }) => regex.test(text)).map(({ phrase }) => phrase);
}

function filesUnder(path, skip) {
  if (!statSync(path, { throwIfNoEntry: false })) return [];
  if (statSync(path).isFile()) return [path];
  const found = [];
  for (const entry of readdirSync(path)) {
    const child = join(path, entry);
    if (child === skip) continue;
    found.push(...filesUnder(child, skip));
  }
  return found;
}

const SHIPPED = [
  ...filesUnder(join(ROOT, 'public'), join(ROOT, 'public', 'vendor')),
  ...filesUnder(join(ROOT, 'server')),
  join(ROOT, 'package.json'),
];

test('the scan itself catches what it should and nothing else', () => {
  assert.deepEqual(hitsIn('Frosty the what now'), ['Frosty']);
  assert.deepEqual(hitsIn('a SNOW   DAY off'), ['snow day']);
  assert.deepEqual(hitsIn('time to build a\nsnowman'), ['build a snowman']);
  assert.deepEqual(hitsIn('let it go, let it go'), ['Let It Go']);
  // Whole words only: these merely contain a banned string.
  assert.deepEqual(hitsIn('Snowpants, Brianna, sveners, tumblebumblebee'), []);
});

test('the scan reaches the shipped tree and skips vendored code', () => {
  assert.ok(SHIPPED.length > 5, 'expected to find the shipped files');
  const paths = SHIPPED.map((file) => relative(ROOT, file));
  assert.ok(paths.includes('package.json'));
  assert.ok(paths.some((file) => file.startsWith('public/shared/')));
  assert.ok(!paths.some((file) => file.startsWith('public/vendor/')));
});

test('no shipped file contains a banned string', () => {
  const offenders = [];
  for (const file of SHIPPED) {
    const hits = hitsIn(readFileSync(file, 'utf8'));
    if (hits.length > 0) offenders.push(`${relative(ROOT, file)}: ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, []);
});
