# Cakes (Slice/Whole Pricing) + Single-Price Food — Design

Approved direction from the owner, 2026-07-20.

## Food: one price

- Add/edit forms: when Type = Food, hide the Price M / Price L inputs (client-side toggle);
  server clears `price_medium`/`price_large` to NULL for food regardless of what's posted.
- Menu table: a category section whose items are ALL food shows a single centered
  **Price** column. (Headers are computed per section.)

## New item type: `cake`

- `menu_items.item_type` CHECK gains `'cake'` (constraint dropped and re-added
  idempotently). No new columns: `price` = per-slice price (required),
  `price_medium` = whole-cake price (optional, NULL = not sold whole),
  `price_large` = always NULL for cakes (server-enforced).
- Forms: Type = Cake relabels the price fields "Per slice" and "Whole cake" (L hidden).
- Menu table: an all-cake section shows **Slice · Whole** columns, dash when no whole
  price. Mixed-type sections show a single Price column with each row's prices
  compactly (e.g. `$4.50 / 5.00 / 5.50`, `$3.25`, `$4.00 / 38.00`).
- Placeholder image: cakes use the food placeholder.

## POS

- Tapping a cake opens the customization panel with a **Slice / Whole** picker (only
  Slice when no whole price — then the picker is hidden and it behaves single-price).
  Sugar and hot/iced pickers are hidden for cakes; the note field follows the shop's
  existing toggle. Default selection: Slice.
- Sale lines for cakes carry `size: 'slice' | 'whole'`. `lib/posLines.js` validates
  size values per item type: drinks accept small/medium/large; cakes accept slice/whole
  (whole only when `price_medium` set); food accepts no size. Pricing: slice → `price`,
  whole → `price_medium` — server-side only, as always.
- `formatLineDetails` renders `Slice` / `Whole` for cake sizes (S/M/L letters stay for
  drink sizes). Receipt, dashboard, and bill JS mirror this.

## Out of scope

- Customer self-order page (unchanged, consistent with drink customizations).
- Any new columns or a variants engine.

## Testing

- Model: cake type round-trips; CHECK accepts cake, still rejects junk.
- posLines: slice/whole pricing, whole rejected when unset, S/M/L rejected on cakes,
  size rejected on food, labels in formatLineDetails.
- Routes: create cake via form (slice+whole), food M/L cleared server-side, POS sale
  with a whole-cake line end-to-end, menu table renders per-section headers.
- Full suite stays green.
