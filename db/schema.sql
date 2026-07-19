-- db/schema.sql
CREATE TABLE IF NOT EXISTS shops (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  invite_code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE shops ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS cover_photo_url TEXT;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff', 'customer')),
  shop_id INTEGER REFERENCES shops(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shop_id_matches_role CHECK (
    (role = 'customer' AND shop_id IS NULL) OR
    (role IN ('owner', 'staff') AND shop_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  items_json TEXT NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_shop_id_idx ON orders(shop_id);
CREATE INDEX IF NOT EXISTS users_shop_id_idx ON users(shop_id);

ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS staff_user_id INTEGER REFERENCES users(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_customer_xor_staff'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_customer_xor_staff CHECK (
      (user_id IS NOT NULL AND staff_user_id IS NULL) OR
      (user_id IS NULL AND staff_user_id IS NOT NULL)
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  category TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  available BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS menu_items_shop_id_idx ON menu_items(shop_id);

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'drink';
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS price_medium NUMERIC(10,2);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS price_large NUMERIC(10,2);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_item_type_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%cake%'
  ) THEN
    ALTER TABLE menu_items DROP CONSTRAINT menu_items_item_type_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_item_type_check'
  ) THEN
    ALTER TABLE menu_items ADD CONSTRAINT menu_items_item_type_check
      CHECK (item_type IN ('drink', 'food', 'cake'));
  END IF;
END $$;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_size BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_sugar BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_temp BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_note BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS category_order TEXT[];

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_url TEXT;

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id),
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  archived BOOLEAN NOT NULL DEFAULT false,
  show_when_empty BOOLEAN NOT NULL DEFAULT false,
  tier_names TEXT[] NOT NULL DEFAULT ARRAY['Price'],
  drink_options BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shop_id, name)
);
CREATE INDEX IF NOT EXISTS categories_shop_id_idx ON categories(shop_id);

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id);

-- Backfill: promote each shop's legacy category strings to category rows,
-- inferring tiers from the item types that lived under them.
INSERT INTO categories (shop_id, name, display_order, tier_names, drink_options)
SELECT m.shop_id, m.category,
  COALESCE(array_position(s.category_order, m.category) - 1, 999),
  CASE WHEN bool_or(m.item_type = 'drink') THEN ARRAY['Small','Medium','Large']
       WHEN bool_or(m.item_type = 'cake') THEN ARRAY['Slice','Whole']
       ELSE ARRAY['Price'] END,
  bool_or(m.item_type = 'drink')
FROM menu_items m JOIN shops s ON s.id = m.shop_id
WHERE m.category_id IS NULL AND m.category IS NOT NULL
GROUP BY m.shop_id, m.category, s.category_order
ON CONFLICT (shop_id, name) DO NOTHING;

UPDATE menu_items m SET category_id = c.id
FROM categories c
WHERE m.category_id IS NULL AND m.category IS NOT NULL
  AND c.shop_id = m.shop_id AND c.name = m.category;

ALTER TABLE menu_items ALTER COLUMN category DROP NOT NULL;
ALTER TABLE menu_items ALTER COLUMN item_type DROP NOT NULL;
