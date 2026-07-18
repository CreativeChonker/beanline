# Shop Discovery — Design

## Context

This is the fourth sub-project in the multi-tenant coffee shop SaaS rebuild, following
[Tenancy & Shop Accounts](2026-07-18-tenancy-shop-accounts-design.md),
[Menu Management](2026-07-18-menu-management-design.md), and
[Point of Sale](2026-07-18-pos-design.md), all merged. It closes an open question flagged
all the way back in the tenancy spec: customers have no way to find a shop other than
being handed a direct link. This adds a scrollable browse feed — customers land here
after login/signup, see every shop on the platform, and tap one to reach its existing
order page.

## Goals

- Replace the `/welcome` placeholder with a real browse feed: every shop on the
  platform, shown as a card (cover photo, name, tagline), tapping one goes straight to
  that shop's existing `/:shopSlug/order` page.
- Let an owner set a tagline and upload a cover photo for their shop.
- Store uploaded photos in real object storage (not local disk, not the database) so
  they survive redeploys on an ephemeral-filesystem host.
- Make the feature fully testable locally without a real cloud storage account.

## Non-goals

- Delivery of any kind — no addresses, no couriers, no tracking. Tapping a shop takes
  the customer to the same pickup/self-order flow that already exists.
- Location/geo filtering ("shops near me") — the feed shows every shop on the platform,
  unfiltered. No distance, no maps.
- Ratings, reviews, or favoriting.
- Search or category filtering on the feed itself (out of scope for this pass — the
  feed is a simple scroll, not a search experience).
- Multiple photos per shop, photo cropping/editing tools, or photos on individual menu
  items (Menu Management's non-goals already excluded item photos; this stays
  consistent).
- Any change to the order flow itself once a customer taps into a shop.

## Data model

`shops` (existing table) gains two nullable columns:

```
shops
  ...existing columns unchanged...
  tagline           TEXT NULL       -- e.g. "Third-wave coffee, cozy vibes"
  cover_photo_url   TEXT NULL       -- URL into object storage, not the image itself
```

Both are optional — a shop with neither set still appears in the feed with just its
name and a neutral placeholder in place of a photo.

## Image storage

Uploaded cover photos are stored in **S3-compatible object storage**, not in Postgres
and not on local disk. The app only ever stores a `cover_photo_url` string; the actual
bytes live in the bucket.

- **Production:** Cloudflare R2 (S3-compatible API, generous free tier).
- **Local dev/test:** [MinIO](https://min.io/) running in Docker Compose alongside the
  existing local Postgres — same pattern already established for mirroring Neon
  locally. The app talks to "an S3-compatible endpoint" via a small storage client;
  only the endpoint/credentials differ between environments (via env vars). This means
  the whole feature is testable without a real Cloudflare account — a real R2 bucket is
  only needed at actual deploy time.
- Upload flow: owner submits a file via a normal HTML form (`multipart/form-data`);
  the server uploads it to the bucket, gets back a URL, and saves that URL to
  `shops.cover_photo_url`. No client-side direct-to-bucket upload, no signed-URL
  complexity — keep this as simple as the rest of this codebase's server-rendered,
  no-build-step style.
- File type/size limits: images only (jpg/png/webp), a reasonable max size (e.g. 5MB) —
  rejected server-side with a form error, not silently truncated or accepted.

## Owner-facing: shop settings

A new page (e.g. `/shop/settings`), owner-only (`requireAuth` + `requireRole('owner')`,
same access pattern as `/menu`), where the owner:
- Sets/edits the shop's tagline (plain text, optional).
- Uploads/replaces the cover photo (optional; uploading a new one replaces the old URL
  — the old object in the bucket is orphaned, not actively deleted, since cleanup isn't
  worth the complexity for this scope).

## Customer-facing: browse feed

`GET /welcome` (existing route, from the tenancy sub-project — currently a static
placeholder) is rewritten to query every shop on the platform and render them as a
scrollable list of cards. Each card shows the cover photo (or a neutral placeholder if
none set), the shop name, and the tagline (or nothing if not set). Tapping a card
navigates to `/:shopSlug/order` — reusing the existing customer ordering flow entirely
unchanged.

Shops are listed in a stable, simple order (e.g. alphabetical by name) — no ranking,
no personalization, no pagination for this pass (the platform doesn't have enough
shops yet for pagination to matter; revisit if it ever does).

## Edge cases

- A shop with no tagline and no cover photo still appears in the feed — never excluded
  just because its profile is incomplete.
- An upload that fails (wrong file type, too large, storage service error) shows a form
  error and does not silently clear the shop's existing photo — a failed replacement
  attempt leaves the prior `cover_photo_url` untouched.
- The platform has zero shops (e.g. a fresh install before anyone signs up): the feed
  shows an empty state, not a blank page or an error.
- A shop is deleted... this doesn't currently exist as an operation anywhere in the app
  (shops are never deleted once created) — not handled here, consistent with the rest
  of the app's scope.

## Testing focus

- The browse feed shows every shop on the platform, including ones with no tagline/photo
  set.
- Tapping a shop card's link genuinely routes to that shop's real `/:shopSlug/order`
  page (the href is built from the shop's actual slug, not guessed/hardcoded).
- Owner settings: tagline and cover photo updates persist and are scoped to the
  owner's own shop only (an owner can't edit another shop's profile via a crafted
  request — same cross-shop isolation discipline as every prior sub-project).
- Upload validation: a non-image file or an oversized file is rejected with a clear
  error, and does not create a dangling/partial object in storage or corrupt the
  existing `cover_photo_url`.
- The storage client works identically against the local MinIO instance in tests as it
  will against real R2 in production — verified by actually exercising an upload
  against MinIO in the test suite, not mocking the storage call away entirely.
