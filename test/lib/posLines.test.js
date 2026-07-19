// test/lib/posLines.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAndPriceLines, formatLineDetails } = require('../../lib/posLines');

const latte = { id: 1, name: 'Latte', price: 4.5, price_medium: 5.0, price_large: 5.5, item_type: 'drink' };
const espresso = { id: 2, name: 'Espresso', price: 3.0, price_medium: null, price_large: null, item_type: 'drink' };
const croissant = { id: 3, name: 'Croissant', price: 3.25, price_medium: null, price_large: null, item_type: 'food' };
const menu = [latte, espresso, croissant];

test('prices a plain line from the base price', () => {
  const result = parseAndPriceLines(JSON.stringify([{ itemId: 2, qty: 2 }]), menu);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.lines, [{ name: 'Espresso', qty: 2, price: 3.0 }]);
  assert.equal(result.total, 6.0);
});

test('prices medium and large from the item size columns, never the client', () => {
  const result = parseAndPriceLines(JSON.stringify([
    { itemId: 1, qty: 1, size: 'medium', price: 0.01 },
    { itemId: 1, qty: 1, size: 'large' },
  ]), menu);
  assert.equal(result.lines[0].price, 5.0);
  assert.equal(result.lines[1].price, 5.5);
  assert.equal(result.total, 10.5);
});

test('keeps customization fields on the line', () => {
  const result = parseAndPriceLines(JSON.stringify([
    { itemId: 1, qty: 1, size: 'small', sugar: 'none', temperature: 'iced', note: '  oat milk  ' },
  ]), menu);
  assert.deepEqual(result.lines[0], {
    name: 'Latte', qty: 1, price: 4.5, size: 'small', sugar: 'none', temperature: 'iced', note: 'oat milk',
  });
});

test('rejects a size the item does not offer', () => {
  const result = parseAndPriceLines(JSON.stringify([{ itemId: 2, qty: 1, size: 'large' }]), menu);
  assert.match(result.error, /size/i);
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

test('formatLineDetails renders the compact combo', () => {
  assert.equal(formatLineDetails({ name: 'Espresso', qty: 1, price: 3 }), '');
  assert.equal(
    formatLineDetails({ name: 'Latte', qty: 1, price: 5, size: 'medium', sugar: 'none', temperature: 'iced', note: 'oat milk' }),
    'M · iced · no sugar · "oat milk"'
  );
  assert.equal(
    formatLineDetails({ name: 'Latte', qty: 1, price: 4.5, size: 'small', sugar: 'normal', temperature: 'hot' }),
    'S'
  );
});
