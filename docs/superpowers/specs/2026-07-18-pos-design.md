# Point of Sale (POS) — Design

## Context

This is the third sub-project in the multi-tenant coffee shop SaaS rebuild, following
[Tenancy & Shop Accounts](2026-07-18-tenancy-shop-accounts-design.md) and
[Menu Management](2026-07-18-menu-management-design.md), both merged. It adds a
staff-facing register: a cashier taking a walk-in, in-person order at the counter, as
opposed to the existing `/:shopSlug/order` flow where a logged-in customer orders for
themselves.

## Goals

- Let a logged-in owner or staff member ring up a walk-in sale: pick items, see a
  running total, choose Cash or Card, complete the sale.
- Reuse the existing card-grid + running-total interaction pattern already built for
  customer self-ordering, so this doesn't invent a new UI language.
- Attribute walk-in orders to the shop and the staff member who processed them —
  never to a customer account, since walk-in customers don't have one.
- Reflect that a POS sale is already paid and handed over: it starts `completed`, not
  `received`.
- Show POS sales alongside self-orders on the existing `/dashboard` order list, with a
  clear "walk-in" distinction from customer orders.

## Non-goals

- Real payment processing — no card reader integration, no Stripe, no actual charge.
  Cash/Card is recorded for the shop's own bookkeeping only. Real payments are a
  separate future sub-project.
- Tipping.
- Receipt printing (physical) — an on-screen receipt after checkout is sufficient.
- Any change to the customer-facing self-order flow (`/:shopSlug/order`) beyond what's
  needed to keep the shared `orders` table consistent for both order types.
- Refunds, voids, or editing a completed sale.

## Data model

`orders` (existing table, from the tenancy sub-project) changes:

```
orders
  ...existing columns unchanged...
  user_id         INTEGER NULL REFERENCES users(id)   -- was NOT NULL; NULL for POS sales
  staff_user_id   INTEGER NULL REFERENCES users(id)   -- NEW: who rang up a POS sale
  payment_method  TEXT NULL                            -- NEW: 'cash' | 'card', POS only

  CONSTRAINT orders_customer_xor_staff CHECK (
    (user_id IS NOT NULL AND staff_user_id IS NULL) OR
    (user_id IS NULL AND staff_user_id IS NOT NULL)
  )
```

Every order is either a customer self-order (`user_id` set, `staff_user_id` NULL,
`payment_method` NULL — unchanged from today) or a POS walk-in sale (`user_id` NULL,
`staff_user_id` set to the session's staff/owner id, `payment_method` set). The CHECK
constraint makes a third, invalid state (both set, or neither set) impossible at the
database level — the same defense-in-depth pattern used for `users.role`/`shop_id` in
the tenancy sub-project.

Since `orders` already exists in every deployed environment (dev, test, and eventually
production), this requires real `ALTER TABLE` statements, not just `CREATE TABLE IF NOT
EXISTS` — there is no real order data anywhere yet worth preserving, so the migration
can be a straightforward structural change without a data-backfill step.

## Route

`GET/POST /pos` — gated by `requireAuth` + `requireRole('owner', 'staff')` (both roles
can work the register, same access as `/dashboard`). No shop slug in the URL — scoped
via `session.user.shopId`, matching `/dashboard` and `/menu`.

- `GET /pos` renders the shop's available menu items as a card grid with a running-total
  panel — the same interaction pattern as `/:shopSlug/order` (click a card to add, qty
  stepper, remove line item, live total), reskinned for the staff app-shell (sidebar
  nav) instead of the customer shell.
- `POST /pos` reads submitted `qty_<id>` fields against the shop's own available
  `menu_items` (identical validation to the customer order route: never trust a
  submitted price, always recompute server-side, silently drop unavailable items even
  if their id is submitted), plus a required `paymentMethod` field (`cash` or `card`).
  Creates an order with `user_id = NULL`, `staff_user_id = session.user.id`,
  `status = 'completed'`, `payment_method` as submitted. Renders an on-screen receipt
  (reusing the existing receipt visual motif from customer confirmation) with a
  "New sale" action that returns to `/pos`.

## Dashboard change

`getOrdersForShop` needs to `LEFT JOIN` on `users` for `user_id` (now nullable) and
additionally join on `staff_user_id` to get the cashier's name for POS rows. The
dashboard view shows:
- Self-order: customer's name and email (unchanged from today).
- POS sale: "Walk-in · rung up by `<staff name>`", no email (there isn't one).

## Edge cases

- A shop with zero available items: `/pos` shows the same empty-menu state as
  `/:shopSlug/order` ("This shop hasn't added anything to their menu yet.") rather than
  a blank or broken register screen.
- `paymentMethod` missing or not `cash`/`card`: reject with a form error, same
  validation style as other forms in this codebase — never silently default to one.
- An unavailable item's id submitted in `qty_<id>`: silently excluded from the sale,
  identical to the customer order route's existing behavior (Menu Management
  sub-project) — a POS sale can't ring up something the shop can't fulfill either.
- Staff member's session expires mid-sale: `requireAuth` redirects to `/login` on the
  `POST /pos` submission, same as any other authenticated route — no partial order is
  created (the whole handler either creates one order or none).

## Testing focus

- A POS sale creates an order with `user_id IS NULL` and `staff_user_id` equal to the
  logged-in staff/owner's id.
- The CHECK constraint genuinely rejects an attempt to insert an order with both
  `user_id` and `staff_user_id` set, or neither set (a direct DB-level test, not just an
  application-level one — the constraint is the actual guarantee).
- `/pos` and `/dashboard` respect the existing cross-shop isolation invariant: staff of
  shop A ringing up a sale never touches shop B's menu items or orders.
- The dashboard renders "Walk-in · rung up by `<name>`" for POS orders and the existing
  customer name/email for self-orders, in the same order list.
- An unavailable item's id submitted to `POST /pos` is excluded from the sale, same as
  the customer order route.
