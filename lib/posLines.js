const SIZES = ['small', 'medium', 'large'];
const SUGARS = ['none', 'less', 'normal', 'extra'];
const TEMPS = ['hot', 'iced'];

const SIZE_LETTER = { small: 'S', medium: 'M', large: 'L' };
const SUGAR_LABEL = { none: 'no sugar', less: 'less sugar', extra: 'extra sugar' };

function sizePrice(item, size) {
  if (!size || size === 'small') return item.price;
  const price = size === 'medium' ? item.price_medium : item.price_large;
  return price === null ? undefined : price;
}

function parseAndPriceLines(rawJson, availableItems) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { error: 'Could not read the sale. Please try again.' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: 'Please select at least one item.' };
  }

  const byId = new Map(availableItems.map((i) => [i.id, i]));
  const lines = [];
  let total = 0;

  for (const raw of parsed) {
    const item = byId.get(Number(raw.itemId));
    if (!item) return { error: 'One of the items is no longer available.' };

    const qty = Number(raw.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { error: 'Invalid quantity.' };

    const line = { name: item.name, qty, price: undefined };

    if (raw.size !== undefined && raw.size !== null && raw.size !== '') {
      if (!SIZES.includes(raw.size)) return { error: 'Invalid size.' };
      line.size = raw.size;
    }
    const price = sizePrice(item, line.size);
    if (price === undefined) return { error: `${item.name} does not come in that size.` };
    line.price = price;

    if (raw.sugar !== undefined && raw.sugar !== null && raw.sugar !== '') {
      if (!SUGARS.includes(raw.sugar)) return { error: 'Invalid sugar level.' };
      line.sugar = raw.sugar;
    }
    if (raw.temperature !== undefined && raw.temperature !== null && raw.temperature !== '') {
      if (!TEMPS.includes(raw.temperature)) return { error: 'Invalid temperature.' };
      line.temperature = raw.temperature;
    }
    if (typeof raw.note === 'string' && raw.note.trim() !== '') {
      const note = raw.note.trim();
      if (note.length > 140) return { error: 'Notes must be 140 characters or fewer.' };
      line.note = note;
    }

    lines.push(line);
    total += price * qty;
  }

  return { lines, total: Math.round(total * 100) / 100 };
}

function formatLineDetails(line) {
  const parts = [];
  if (line.size) parts.push(SIZE_LETTER[line.size]);
  if (line.temperature === 'iced') parts.push('iced');
  if (line.sugar && line.sugar !== 'normal') parts.push(SUGAR_LABEL[line.sugar]);
  if (line.note) parts.push(`"${line.note}"`);
  return parts.join(' · ');
}

module.exports = { parseAndPriceLines, formatLineDetails, SIZES, SUGARS, TEMPS };
