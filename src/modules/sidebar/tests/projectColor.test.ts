import assert from 'node:assert/strict';

import { test } from 'vitest';

import { colorFromText, isHexColor, withAlpha } from '@/modules/sidebar/utils/projectColor';

test('a project name always maps to the same #rrggbb colour', () => {
  assert.equal(colorFromText('GolfN'), colorFromText('GolfN'));
  assert.equal(colorFromText('  golfn '), colorFromText('GolfN'), 'case and outer spaces do not matter');
  assert.ok(isHexColor(colorFromText('GolfN')));
  assert.ok(isHexColor(colorFromText('')));
});

test('different project names get different colours', () => {
  const names = ['GolfN', 'Kvn', 'claudecodeui', 'kvn-hub', 'winback'];
  assert.equal(new Set(names.map(colorFromText)).size, names.length);
});

test('only #rrggbb counts as a stored colour, and alpha tints convert to rgba', () => {
  assert.ok(isHexColor('#a1B2c3'));
  assert.ok(!isHexColor('a1b2c3'));
  assert.ok(!isHexColor('#abc'));
  assert.ok(!isHexColor(null));
  assert.equal(withAlpha('#ff8000', 0.5), 'rgba(255, 128, 0, 0.5)');
});
