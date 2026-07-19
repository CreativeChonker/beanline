// test/lib/posLines.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAndPriceLines, formatLineDetails } = require('../../lib/posLines');

const DRINK_TIERS = ['Small', 'Medium', 'Large'];
const latte = { id: 1, name: 'Latte', price: 4.5, price_medium: 5.0, price_large: 5.5, tier_names: DRINK_TIERS };
const espresso = { id: 2, name: 'Espresso', price: 3.0, price_medium: null, price_large: null, tier_names: DRINK_TIERS };
const croissant = { id: 3, name: 'Croissant', price: 3.25, price_medium: null, price_large: null, tier_names: ['Price'] };
const menu = [latte, espresso, croissant];

test('prices a plain line from the base price and tier 0 by default', () => {
  const result = parseAndPriceLines(JSON.stringify([{ itemId: 3, qty: 2 }]), menu);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.lines, [{ name: 'Croissant', qty: 2, price: 3.25 }]);
  assert.equal(result.total, 6.5);
});

test('prices tiers from the item columns, never the client', () => {
  const result = parseAndPriceLines(JSON.stringify([
    { itemId: 1, qty: 1, tier: 1, price: 0.01 },
    { itemId: 1, qty: 1, tier: 2 },
  ]), menu);
  assert.equal(result.lines[0].price, 5.0);
  assert.equal(result.lines[0].tier_label, 'Medium');
  assert.equal(result.lines[1].price, 5.5);
  assert.equal(result.total, 10.5);
});

test('keeps customization fields on the line', () => {
  const result = parseAndPriceLines(JSON.stringify([
    { itemId: 1, qty: 1, tier: 0, sugar: 'none', temperature: 'iced', note: '  oat milk  ' },
  ]), menu);
  assert.deepEqual(result.lines[0], {
    name: 'Latte', qty: 1, price: 4.5, tier_label: 'Small', sugar: 'none', temperature: 'iced', note: 'oat milk',
  });
});

test('rejects a tier the item does not offer', () => {
  assert.match(parseAndPriceLines(JSON.stringify([{ itemId: 2, qty: 1, tier: 2 }]), menu).error, /option/i);
  assert.match(parseAndPriceLines(JSON.stringify([{ itemId: 3, qty: 1, tier: 1 }]), menu).error, /option/i);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 1, tier: 5 }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 1, tier: -1 }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 1, tier: 'big' }]), menu).error);
});

test('rejects unknown items, bad enums, bad qty, oversized notes, and bad JSON', () => {
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 999, qty: 1 }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 1, sugar: 'heaps' }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 1, temperature: 'lukewarm' }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 0 }]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 1, qty: 1, note: 'x'.repeat(141) }]), menu).error);
  assert.ok(parseAndPriceLines('not json', menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify([]), menu).error);
  assert.ok(parseAndPriceLines(JSON.stringify({ itemId: 1 }), menu).error);
});

test('single-tier categories never label the tier', () => {
  const result = parseAndPriceLines(JSON.stringify([{ itemId: 3, qty: 1, tier: 0 }]), menu);
  assert.equal(result.lines[0].tier_label, undefined);
});

test('custom tier names price and label generically', () => {
  const cake = { id: 4, name: 'Carrot Cake', price: 4.0, price_medium: 38.0, price_large: null, tier_names: ['Slice', 'Whole'] };
  const result = parseAndPriceLines(JSON.stringify([
    { itemId: 4, qty: 1, tier: 0 },
    { itemId: 4, qty: 1, tier: 1 },
  ]), [cake]);
  assert.equal(result.error, undefined);
  assert.equal(result.lines[0].price, 4.0);
  assert.equal(result.lines[0].tier_label, 'Slice');
  assert.equal(result.lines[1].price, 38.0);
  assert.equal(result.lines[1].tier_label, 'Whole');
  assert.equal(result.total, 42.0);
  // second tier without a price is rejected
  const sliceOnly = { ...cake, id: 5, price_medium: null };
  assert.ok(parseAndPriceLines(JSON.stringify([{ itemId: 5, qty: 1, tier: 1 }]), [sliceOnly]).error);
});

test('formatLineDetails renders the compact combo from tier labels', () => {
  assert.equal(formatLineDetails({ name: 'Espresso', qty: 1, price: 3 }), '');
  assert.equal(
    formatLineDetails({ name: 'Latte', qty: 1, price: 5, tier_label: 'Medium', sugar: 'none', temperature: 'iced', note: 'oat milk' }),
    'Medium · iced · no sugar · "oat milk"'
  );
});

test('formatLineDetails still renders legacy size-based lines from stored orders', () => {
  assert.equal(formatLineDetails({ name: 'Latte', qty: 1, price: 5, size: 'medium', temperature: 'iced' }), 'M · iced');
  assert.equal(formatLineDetails({ name: 'Carrot Cake', qty: 1, price: 38, size: 'whole', note: 'birthday' }), 'Whole · "birthday"');
});
