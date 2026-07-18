# Tenancy & Shop Accounts — Design

## Context

The app is being turned from a single-shop demo into a multi-tenant SaaS product sold to
many independent coffee shops. Today everything is global: one hardcoded menu
(`menu.js`), one `users` table with no concept of "which shop," and a staff dashboard
that shows every order ever placed regardless of shop.

This is the foundational sub-project. Menu management, POS, the kitchen/order dashboard
rebuild, payments, staff permissions, and SaaS billing are separate sub-projects that
depend on this one and are explicitly out of scope here (see Non-goals).

## Goals

- Introduce a `shop` as the tenant boundary that staff, orders, and (eventually) menus
  belong to.
- Let anyone self-serve create a shop and become its owner.
- Let an owner bring staff on board via an invite code.
- Keep customer accounts global (one account, many shops) rather than per-shop.
- Make cross-shop data isolation structurally hard to get wrong.

## Stack & infra

Decided now because it affects how this sub-project is built, even though payments
hosting choices mostly serve later sub-projects too:

- **Database: PostgreSQL via Neon (free tier)**, replacing `better-sqlite3`. A single
  local SQLite file doesn't survive on most hosts (ephemeral disks, multiple
  instances), and Postgres is the standard choice for multi-tenant SaaS. Neon's free
  tier includes connection pooling, which matters once the app runs as short-lived
  request handlers. Keep raw SQL via the `pg` driver rather than adding an ORM — the
  app is intentionally lightweight and an ORM like Prisma can be introduced later without a
  rewrite if the schema grows complex enough to need migrations tooling.
- **Sessions: `connect-pg-simple`**, storing sessions in the same Postgres database
  instead of `express-session`'s default in-memory store (which leaks memory and
  breaks the moment there's more than one server instance).
- **Hosting: Render (free tier)**, chosen over Vercel because this is a stateful
  Express app with server-rendered EJS views, not a serverless-shaped app — Render
  runs it as a normal persistent Node process with no rewrite hacks. Trade-off: free
  web services spin down after ~15 minutes idle and take 30-60s to wake on the next
  request. Acceptable while validating the product with early shop owners; removed by
  upgrading to Render's paid tier later with no code changes.
- **Payments (future sub-projects, decided now for consistency): Stripe.**
  Stripe Connect for shops to receive their customers' payments directly (with an
  optional platform fee), and Stripe Billing for charging shop owners their platform
  subscription. Not implemented in this sub-project — noted here so the data model and
  hosting choice don't conflict with it later.

## Data model

```
shops
  id            INTEGER PRIMARY KEY
  name          TEXT NOT NULL
  slug          TEXT NOT NULL UNIQUE   -- URL-safe: lowercase letters, digits, hyphens
  invite_code   TEXT NOT NULL UNIQUE
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))

users
  id            INTEGER PRIMARY KEY
  name          TEXT NOT NULL
  email         TEXT NOT NULL UNIQUE
  password_hash TEXT NOT NULL
  role          TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'customer'))
  shop_id       INTEGER NULL REFERENCES shops(id)   -- NULL for customers, set for owner/staff
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))

orders
  id            INTEGER PRIMARY KEY
  user_id       INTEGER NOT NULL REFERENCES users(id)
  shop_id       INTEGER NOT NULL REFERENCES shops(id)
  items_json    TEXT NOT NULL
  total         REAL NOT NULL
  status        TEXT NOT NULL DEFAULT 'received'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
```

This is the standard shared-database, `shop_id`-column pattern used by most B2B SaaS
before scale demands per-tenant sharding. It scales to thousands of shops with indexes
alone (`CREATE INDEX ON orders(shop_id)`, `CREATE INDEX ON users(shop_id)`); sharding by
`shop_id` later is an infrastructure swap, not a schema redesign.

A `CHECK` constraint enforces `shop_id IS NULL` for customers and `shop_id IS NOT NULL`
for owner/staff at the database level, in addition to application-level validation:

```sql
CHECK (
  (role = 'customer' AND shop_id IS NULL) OR
  (role IN ('owner', 'staff') AND shop_id IS NOT NULL)
)
```

## Routing & auth

- **Customer-facing, shop-scoped** — URL carries the shop slug:
  - `GET /:shopSlug/order` — look up shop by slug; 404 if not found.
  - (Future: `GET /:shopSlug/menu` for browsing before login.)
- **Staff-facing, no slug** — scoped implicitly via the session, since a staff account
  belongs to exactly one shop:
  - `GET /dashboard` (existing, becomes shop-filtered)
  - Future: `/pos`, `/menu/edit`, etc.
- `requireRole(['owner', 'staff'])` replaces the current single-role `requireRole('staff')`.
- **Every staff-side query filters by `session.user.shop_id`.** The shop id used for
  scoping is never taken from a route param, query string, or form field on staff
  routes — only from the authenticated session. This is the one invariant that must
  hold everywhere: a staff session for shop A must never be able to read or write shop
  B's data.

## Signup flows

Three distinct entry points replace today's single customer/staff role picker on one
signup form:

1. **Create a shop** — `GET/POST /shops/new`
   Input: shop name, slug, owner's name/email/password.
   Action: validate slug is unique and URL-safe; create `shops` row with a generated
   `invite_code`; create `users` row with `role='owner'`, `shop_id` set; log the owner in.

2. **Join a shop as staff** — `GET/POST /signup/staff`
   Input: name/email/password, invite code.
   Action: look up `shops` by `invite_code`; if not found, form error ("Invalid invite
   code"), no account created. Otherwise create `users` row with `role='staff'`,
   `shop_id` from the matched shop; log in.

3. **Customer signup** — `GET/POST /signup` (existing route, simplified)
   Input: name/email/password only — no shop context at signup time.
   Action: create `users` row with `role='customer'`, `shop_id=NULL`; log in.

Login (`POST /login`) is unchanged in shape — it already looks up by email and doesn't
care about role — but post-login redirect logic needs a third branch:
- `owner` → `/dashboard`
- `staff` → `/dashboard`
- `customer` → prompt to pick/visit a shop (no shop-agnostic landing page exists yet;
  see Open question below)

## Non-goals (deferred to their own sub-projects)

- **Menu management.** `menu.js` remains a single shared static file. Every shop's
  `/:shopSlug/order` page renders the *same* placeholder menu until the Menu Management
  sub-project introduces per-shop menu items in the database.
- **POS / in-person checkout**, **payments**, **staff invite-by-email**, **invite code
  rotation/expiry**, **granular permissions beyond the owner/staff split**, and **SaaS
  billing** (charging shop owners a subscription) are all separate sub-projects.
- **Kitchen/order status workflow.** The dashboard is updated only enough to filter
  orders by `shop_id`; the received → preparing → ready → completed status workflow is
  part of the future Order/Kitchen Dashboard sub-project.

## Migration

Fresh start, and also a storage-engine swap: `data.db` (SQLite) is retired in favor of
a Neon Postgres database, created fresh with the new schema. No existing prototype
users/orders are preserved — nothing in there is real customer data. `db.js` is
rewritten against the `pg` driver instead of `better-sqlite3`.

## Edge cases

- Duplicate slug or invite code on shop creation → validation error, ask for a
  different slug (invite code is server-generated, so a collision is regenerated
  silently).
- Slug restricted to `^[a-z0-9-]+$`, rejected otherwise with a clear message.
- Unknown slug on `/:shopSlug/order` → 404 page, not a crash.
- Unknown/invalid invite code on staff signup → form error, no account created.
- A logged-in customer visiting a shop they've never ordered from before → treated the
  same as any other visit; no per-shop customer record needed since customers are global.

## Open question for the next sub-project

Once a customer logs in, where do they land? There's no shop directory/landing page
yet — that's reasonable to leave for the Menu Management or a future "Customer
Discovery" sub-project, but flagging it now so it isn't forgotten. For this sub-project,
customers without a shop in mind will see a minimal "enter a shop's link to order"
placeholder rather than a real directory page.

## Testing focus

- Cross-shop isolation: staff of shop A cannot see, via any route, orders or data
  belonging to shop B (this is the one thing that must be bulletproof).
- Slug and invite-code uniqueness constraints hold under concurrent shop creation.
- Customer accounts can place orders against multiple different shops using one login.
- Role-based redirect after login/signup sends each of the three roles to the right
  place.
