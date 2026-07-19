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
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_item_type_check'
  ) THEN
    ALTER TABLE menu_items ADD CONSTRAINT menu_items_item_type_check
      CHECK (item_type IN ('drink', 'food'));
  END IF;
END $$;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_size BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_sugar BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_temp BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pos_show_note BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS category_order TEXT[];
