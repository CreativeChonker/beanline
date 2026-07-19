# Beanline ☕

A multi-tenant coffee shop platform. Shops sign up, build their menu, and get two ways to sell: a customer self-ordering page and a staff-facing POS register. Customers get a browse feed of every shop on the platform and can order ahead from any of them with one account.

## Features

- **Multi-tenant from the ground up** — each shop is an isolated tenant with its own menu, orders, staff, and settings. Cross-shop access is blocked at the query level and locked in by tests.
- **Roles** — owners manage the shop, staff run the register, customers order. Staff join via invite code.
- **Self-ordering** — every shop gets a customer-facing menu at `/<slug>/order` with an order confirmation flow.
- **POS register** — staff ring up walk-in sales; the dashboard distinguishes walk-ins from customer self-orders.
- **Menu management** — owners create, edit, price, toggle, and delete items, grouped by category.
- **Shop discovery** — a browse feed of every shop (cover photo, tagline) that links to each shop's order page.
- **Shop settings** — owners set a tagline and upload a cover photo. Images live in S3-compatible object storage (MinIO locally, Cloudflare R2 in production); the database only ever stores a URL.

## Stack

Node.js · Express · EJS · PostgreSQL (raw SQL via `pg`, no ORM) · `node:test` + Supertest against a real database · Docker Compose for local Postgres and MinIO.

## Getting started

Requires Node.js 20+ and Docker.

```bash
git clone https://github.com/CreativeChonker/beanline.git
cd beanline
npm install

# Start Postgres + MinIO
docker compose up -d

# Configure environment
cp .env.example .env   # defaults work as-is for local dev; set a real SESSION_SECRET

# Create tables (idempotent — safe to re-run)
npm run migrate

# Run it
npm start
```

Open http://localhost:3000, create a shop, and you're an owner. Add menu items under **Menu**, then visit `/<your-slug>/order` as a customer to place an order.

## Tests

```bash
npm test
```

The suite runs against the real Postgres and MinIO containers (no mocks), covering models, middleware, routes, and cross-tenant isolation.

## Environment

All configuration is via `.env` — see [.env.example](.env.example) for the full list. The notable ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` / `TEST_DATABASE_URL` | Postgres connections (dev and test databases) |
| `SESSION_SECRET` | Session cookie signing — set a real value |
| `STORAGE_*` | S3-compatible object storage for cover photos. Points at local MinIO by default; point at Cloudflare R2 (or any S3-compatible store) in production — same code path, different credentials |
| `N8N_WEBHOOK_URL` | Optional: POSTs each customer order as JSON to an automation webhook |

## Project layout

```
server.js          Express app: routes, sessions, auth wiring
models/            Raw-SQL data access (shops, users, menuItems, orders)
middleware/        requireAuth, requireRole, loadShopBySlug
lib/storage.js     S3-compatible upload client (only code that touches image bytes)
views/             EJS templates
db/                schema.sql + migration runner
test/              node:test suites (run against real Postgres)
docs/superpowers/  Design specs and implementation plans for each sub-project
```
