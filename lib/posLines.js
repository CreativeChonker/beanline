const SUGARS = ['none', 'less', 'normal', 'extra'];
const TEMPS = ['hot', 'iced'];

// Legacy labels so orders stored before category tiers still format.
const SIZE_LETTER = { small: 'S', medium: 'M', large: 'L', slice: 'Slice', whole: 'Whole' };
const SUGAR_LABEL = { none: 'no sugar', less: 'less sugar', extra: 'extra sugar' };

// An item's price for tier index i (tiers map onto price, price_medium, price_large).
function tierPrice(item, i) {
  const prices = [item.price, item.price_medium, item.price_large];
  const p = prices[i];
  return p === null || p === undefined ? undefined : p;
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

    const tiers = item.tier_names || ['Price'];
    let tier = 0;
    if (raw.tier !== undefined && raw.tier !== null && raw.tier !== '') {
      tier = Number(raw.tier);
      if (!Number.isInteger(tier) || tier < 0 || tier >= tiers.length) {
        return { error: `${item.name} does not come in that option.` };
      }
    }
    const price = tierPrice(item, tier);
    if (price === undefined) return { error: `${item.name} does not come in that option.` };

    const line = { name: item.name, qty, price };
    // Only label the tier when the category has more than one.
    if (tiers.length > 1) line.tier_label = tiers[tier];

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
  if (line.tier_label) parts.push(line.tier_label);
  else if (line.size) parts.push(SIZE_LETTER[line.size] || line.size);
  if (line.temperature === 'iced') parts.push('iced');
  if (line.sugar && line.sugar !== 'normal') parts.push(SUGAR_LABEL[line.sugar]);
  if (line.note) parts.push(`"${line.note}"`);
  return parts.join(' · ');
}

module.exports = { parseAndPriceLines, formatLineDetails, SUGARS, TEMPS };
