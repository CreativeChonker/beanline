require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./db');
const shops = require('./models/shops');
const users = require('./models/users');
const orders = require('./models/orders');
const menuItems = require('./models/menuItems');
const categories = require('./models/categories');
const seedMenu = require('./db/seed-menu');
const { requireAuth, requireRole, loadShopBySlug } = require('./middleware/auth');
const multer = require('multer');
const storage = require('./lib/storage');
const posLines = require('./lib/posLines');
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
const pgSession = require('connect-pg-simple')(session);

app.use(
  session({
    store: new pgSession({ pool: db.pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return res.redirect(req.session.user.role === 'customer' ? '/welcome' : '/dashboard');
});

// --- Auth ---

app.get('/shops/new', (req, res) => {
  res.render('shop-new', { error: null });
});

app.post('/shops/new', async (req, res, next) => {
  const { shopName, slug, ownerName, email, password } = req.body;
  if (!shopName || !slug || !ownerName || !email || !password) {
    return res.render('shop-new', { error: 'Please fill out all fields.' });
  }
  try {
    const result = await db.withTransaction(async (client) => {
      const shop = await shops.createShop(client, { name: shopName, slug });
      const owner = await users.createOwner(client, { name: ownerName, email, password, shopId: shop.id });
      const catIds = {};
      for (const cat of seedMenu.categories) {
        const created = await categories.createCategory(client, { shopId: shop.id, ...cat });
        catIds[cat.name] = created.id;
      }
      for (const item of seedMenu.items) {
        const { category, ...fields } = item;
        await menuItems.createMenuItem(client, { shopId: shop.id, categoryId: catIds[category], ...fields });
      }
      return { shop, owner };
    });
    req.session.user = {
      id: result.owner.id,
      name: result.owner.name,
      email: result.owner.email,
      role: result.owner.role,
      shopId: result.shop.id,
    };
    res.redirect('/dashboard');
  } catch (err) {
    if (err.message === 'INVALID_SLUG') {
      return res.render('shop-new', { error: 'Shop URL can only contain lowercase letters, numbers, and hyphens.' });
    }
    if (err.code === '23505') {
      return res.render('shop-new', { error: 'That shop URL or email is already taken.' });
    }
    next(err);
  }
});

app.get('/signup/staff', (req, res) => {
  res.render('signup-staff', { error: null });
});

app.post('/signup/staff', async (req, res, next) => {
  const { name, email, password, inviteCode } = req.body;
  if (!name || !email || !password || !inviteCode) {
    return res.render('signup-staff', { error: 'Please fill out all fields.' });
  }
  try {
    const shop = await shops.getShopByInviteCode(db, inviteCode);
    if (!shop) {
      return res.render('signup-staff', { error: 'Invalid invite code.' });
    }
    const user = await users.createStaff(db, { name, email, password, shopId: shop.id });
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, shopId: shop.id };
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === '23505') {
      return res.render('signup-staff', { error: 'An account with that email already exists.' });
    }
    next(err);
  }
});

app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

app.post('/signup', async (req, res, next) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.render('signup', { error: 'Please fill out all fields.' });
  }
  try {
    const user = await users.createCustomer(db, { name, email, password });
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, shopId: null };
    res.redirect('/welcome');
  } catch (err) {
    if (err.code === '23505') {
      return res.render('signup', { error: 'An account with that email already exists.' });
    }
    next(err);
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res, next) => {
  const { email, password } = req.body;
  try {
    const user = await users.getUserByEmail(db, email);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.render('login', { error: 'Invalid email or password.' });
    }
    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, shopId: user.shop_id };
    return res.redirect(user.role === 'customer' ? '/welcome' : '/dashboard');
  } catch (err) {
    next(err);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- Customer ordering ---

app.get('/welcome', requireAuth, requireRole('customer'), async (req, res, next) => {
  try {
    const allShops = await shops.getAllShops(db);
    res.render('welcome', { shops: allShops });
  } catch (err) {
    next(err);
  }
});

app.get('/:shopSlug/order', requireAuth, requireRole('customer'), loadShopBySlug, async (req, res, next) => {
  try {
    const items = await menuItems.getMenuItemsForShop(db, req.shop.id, { availableOnly: true });
    res.render('order', { menu: items, error: null, shop: req.shop });
  } catch (err) {
    next(err);
  }
});

app.post('/:shopSlug/order', requireAuth, requireRole('customer'), loadShopBySlug, async (req, res, next) => {
  try {
    const availableItems = await menuItems.getMenuItemsForShop(db, req.shop.id, { availableOnly: true });
    const items = [];
    let total = 0;
    for (const item of availableItems) {
      const qty = parseInt(req.body['qty_' + item.id], 10) || 0;
      if (qty > 0) {
        items.push({ name: item.name, qty, price: item.price });
        total += qty * item.price;
      }
    }

    if (items.length === 0) {
      return res.render('order', { menu: availableItems, error: 'Please select at least one item.', shop: req.shop });
    }

    const created = await orders.createOrder(db, {
      userId: req.session.user.id,
      shopId: req.shop.id,
      items,
      total,
    });

    const order = {
      order_id: created.id,
      customer_name: req.session.user.name,
      customer_email: req.session.user.email,
      items: items.map((i) => `${i.name} x${i.qty}`).join(', '),
      lineItems: items,
      total: total.toFixed(2),
      created_at: created.created_at,
    };

    if (process.env.N8N_WEBHOOK_URL) {
      try {
        await fetch(process.env.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(order),
        });
      } catch (err) {
        console.error('Failed to notify n8n webhook:', err.message);
      }
    }

    res.render('confirmation', { order, shop: req.shop });
  } catch (err) {
    next(err);
  }
});

// --- Staff dashboard ---

app.get('/dashboard', requireAuth, requireRole('owner', 'staff'), async (req, res, next) => {
  try {
    const [shopOrders, shop] = await Promise.all([
      orders.getOrdersForShop(db, req.session.user.shopId),
      shops.getShopById(db, req.session.user.shopId),
    ]);
    res.render('dashboard', { orders: shopOrders, shop, formatLine: posLines.formatLineDetails });
  } catch (err) {
    next(err);
  }
});

app.get('/pos', requireAuth, requireRole('owner', 'staff'), async (req, res, next) => {
  try {
    const [items, cats, shop] = await Promise.all([
      menuItems.getMenuItemsForShop(db, req.session.user.shopId, { availableOnly: true }),
      categories.getCategoriesForShop(db, req.session.user.shopId, { includeArchived: false }),
      shops.getShopById(db, req.session.user.shopId),
    ]);
    res.render('pos', { menu: items, categories: cats, shop, error: null, formatLine: posLines.formatLineDetails });
  } catch (err) {
    next(err);
  }
});

app.post('/pos', requireAuth, requireRole('owner', 'staff'), async (req, res, next) => {
  const { paymentMethod } = req.body;
  try {
    const [availableItems, cats, shop] = await Promise.all([
      menuItems.getMenuItemsForShop(db, req.session.user.shopId, { availableOnly: true }),
      categories.getCategoriesForShop(db, req.session.user.shopId, { includeArchived: false }),
      shops.getShopById(db, req.session.user.shopId),
    ]);
    const rerender = (error) => res.render('pos', { menu: availableItems, categories: cats, shop, error, formatLine: posLines.formatLineDetails });

    const parsed = posLines.parseAndPriceLines(req.body.lines || '', availableItems);
    if (parsed.error) return rerender(parsed.error);
    if (!['cash', 'card'].includes(paymentMethod)) return rerender('Please choose a payment method.');

    const created = await orders.createOrder(db, {
      staffUserId: req.session.user.id,
      shopId: req.session.user.shopId,
      items: parsed.lines,
      total: parsed.total,
      status: 'completed',
      paymentMethod,
    });

    res.render('pos-receipt', {
      sale: {
        order_id: created.id,
        staff_name: req.session.user.name,
        lineItems: parsed.lines,
        total: parsed.total.toFixed(2),
        payment_method: paymentMethod,
        created_at: created.created_at,
      },
      formatLine: posLines.formatLineDetails,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/pos/layout', requireAuth, requireRole('owner'), async (req, res, next) => {
  const { categoryOrder, items } = req.body;
  const isId = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
  if (!Array.isArray(categoryOrder) || !Array.isArray(items)
      || categoryOrder.length > 500 || items.length > 500
      || !categoryOrder.every(isId)
      || !items.every((i) => i && isId(i.id) && isId(i.categoryId)
        && Number.isInteger(Number(i.sortOrder)) && Number(i.sortOrder) >= 0 && Number(i.sortOrder) <= 100000)) {
    return res.status(400).send('Invalid layout.');
  }
  try {
    await menuItems.updateLayout(db, req.session.user.shopId, items.map((i) => ({
      id: Number(i.id), categoryId: Number(i.categoryId), sortOrder: Number(i.sortOrder),
    })));
    await categories.updateDisplayOrder(db, req.session.user.shopId, categoryOrder.map(Number));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- Owner menu editor ---

const ITEM_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

async function uploadItemImage(shopId, itemId, file) {
  const ext = file.mimetype.split('/')[1];
  const key = `shops/${shopId}/items/${itemId}-${Date.now()}.${ext}`;
  return storage.uploadImage(file.buffer, key, file.mimetype);
}

// Resolves the target category (creating one when categoryNew is given) and
// validates one price per tier of that category. Tier 1 is required; later
// tiers are optional (rendered as a dash when unset).
async function parseMenuItemForm(shopId, body, file) {
  const { name, categoryId, categoryNew, price, note, priceMedium, priceLarge } = body;
  const parseTier = (v) => {
    if (v === undefined || v === '') return null;
    const n = parseFloat(v);
    return Number.isNaN(n) || n <= 0 ? undefined : n;
  };
  const parsed = [parseTier(price), parseTier(priceMedium), parseTier(priceLarge)];
  if (!name || parsed[0] === null || parsed.some((p) => p === undefined)) {
    return { error: 'Please provide a name, category, and a valid price.' };
  }
  if (file && !ITEM_IMAGE_TYPES.includes(file.mimetype)) {
    return { error: 'Please upload a JPG, PNG, or WEBP image.' };
  }

  let category;
  if (categoryNew !== undefined && categoryNew !== '') {
    const catName = String(categoryNew).trim();
    if (!catName || catName.length > 50) return { error: 'Category names must be 1–50 characters.' };
    try {
      category = await categories.createCategory(db, { shopId, name: catName });
    } catch (err) {
      if (err.code === '23505') return { error: 'A category with that name already exists.' };
      throw err;
    }
  } else {
    category = await categories.getCategoryById(db, shopId, Number(categoryId));
    if (!category) return { error: 'Please choose a category.' };
  }

  const tiers = category.tier_names;
  return {
    fields: {
      name, categoryId: category.id, note: note || '',
      price: parsed[0],
      priceMedium: tiers.length > 1 ? parsed[1] : null,
      priceLarge: tiers.length > 2 ? parsed[2] : null,
    },
  };
}

// Owner category management: parse and validate the shared category form.
function parseCategoryForm(body) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 50) return { error: 'Category names must be 1–50 characters.' };
  const tierNames = String(body.tierNames || 'Price').split(',').map((t) => t.trim()).filter(Boolean);
  if (tierNames.length < 1 || tierNames.length > 3 || tierNames.some((t) => t.length > 20)) {
    return { error: 'Categories need 1–3 price tiers, each named up to 20 characters.' };
  }
  return {
    fields: {
      name, tierNames,
      drinkOptions: body.drinkOptions === 'on',
      showWhenEmpty: body.showWhenEmpty === 'on',
      archived: body.archived === 'on',
    },
  };
}

async function renderMenuEditor(res, shopId, error, values) {
  const [items, cats, shop] = await Promise.all([
    menuItems.getMenuItemsForShop(db, shopId),
    categories.getCategoriesForShop(db, shopId),
    shops.getShopById(db, shopId),
  ]);
  res.render('menu-edit', { items, categories: cats, shop, error, values: values || {} });
}

app.get('/menu', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    await renderMenuEditor(res, req.session.user.shopId, null);
  } catch (err) {
    next(err);
  }
});

// --- Owner category management ---

app.post('/categories', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const parsed = parseCategoryForm(req.body);
    if (parsed.error) return await renderMenuEditor(res, req.session.user.shopId, parsed.error);
    const { archived, ...fields } = parsed.fields;
    await categories.createCategory(db, { shopId: req.session.user.shopId, ...fields });
    res.redirect('/menu');
  } catch (err) {
    if (err.code === '23505') return renderMenuEditor(res, req.session.user.shopId, 'A category with that name already exists.').catch(next);
    next(err);
  }
});

app.post('/categories/:id', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const shopId = req.session.user.shopId;
    const existing = await categories.getCategoryById(db, shopId, req.params.id);
    if (!existing) return res.status(404).send('Category not found.');
    const parsed = parseCategoryForm(req.body);
    if (parsed.error) return await renderMenuEditor(res, shopId, parsed.error);
    const displayOrder = Number.isInteger(Number(req.body.displayOrder))
      ? Number(req.body.displayOrder) : existing.display_order;
    await categories.updateCategory(db, shopId, existing.id, { ...parsed.fields, displayOrder });
    res.redirect('/menu');
  } catch (err) {
    if (err.code === '23505') return renderMenuEditor(res, req.session.user.shopId, 'A category with that name already exists.').catch(next);
    next(err);
  }
});

app.post('/categories/:id/delete', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const shopId = req.session.user.shopId;
    const existing = await categories.getCategoryById(db, shopId, req.params.id);
    if (!existing) return res.status(404).send('Category not found.');
    const deleted = await categories.deleteCategory(db, shopId, existing.id);
    if (!deleted) return await renderMenuEditor(res, shopId, 'Move or delete the items in that category first.');
    res.redirect('/menu');
  } catch (err) {
    next(err);
  }
});

app.post('/menu', requireAuth, requireRole('owner'), (req, res, next) => {
  upload.single('itemImage')(req, res, async (uploadErr) => {
    const shopId = req.session.user.shopId;
    const rerender = (error, values) => renderMenuEditor(res, shopId, error, values);
    try {
      if (uploadErr) {
        const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : 'Upload failed.';
        return await rerender(message, req.body);
      }
      const parsed = await parseMenuItemForm(shopId, req.body, req.file);
      if (parsed.error) {
        return await rerender(parsed.error, req.body);
      }
      const item = await menuItems.createMenuItem(db, { shopId, ...parsed.fields });
      if (req.file) {
        const url = await uploadItemImage(shopId, item.id, req.file);
        await menuItems.setItemImage(db, shopId, item.id, url);
      }
      res.redirect('/menu');
    } catch (err) {
      next(err);
    }
  });
});

app.get('/menu/:id/edit', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const [item, cats, shop] = await Promise.all([
      menuItems.getMenuItemById(db, req.session.user.shopId, req.params.id),
      categories.getCategoriesForShop(db, req.session.user.shopId),
      shops.getShopById(db, req.session.user.shopId),
    ]);
    if (!item) return res.status(404).send('Item not found.');
    res.render('menu-item-edit', { item, categories: cats, shop, error: null });
  } catch (err) {
    next(err);
  }
});

app.post('/menu/:id', requireAuth, requireRole('owner'), (req, res, next) => {
  upload.single('itemImage')(req, res, async (uploadErr) => {
    const shopId = req.session.user.shopId;
    try {
      const rerender = async (error) => {
        const [item, cats, shop] = await Promise.all([
          menuItems.getMenuItemById(db, shopId, req.params.id),
          categories.getCategoriesForShop(db, shopId),
          shops.getShopById(db, shopId),
        ]);
        if (!item) return res.status(404).send('Item not found.');
        return res.render('menu-item-edit', { item, categories: cats, shop, error });
      };
      if (uploadErr) {
        const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : 'Upload failed.';
        return await rerender(message);
      }
      const parsed = await parseMenuItemForm(shopId, req.body, req.file);
      if (parsed.error) {
        return await rerender(parsed.error);
      }
      const updated = await menuItems.updateMenuItem(db, shopId, req.params.id, { ...parsed.fields });
      if (!updated) return res.status(404).send('Item not found.');
      if (req.file) {
        const url = await uploadItemImage(shopId, req.params.id, req.file);
        await menuItems.setItemImage(db, shopId, req.params.id, url);
      }
      res.redirect('/menu');
    } catch (err) {
      next(err);
    }
  });
});

app.post('/menu/:id/toggle', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const updated = await menuItems.toggleAvailability(db, req.session.user.shopId, req.params.id);
    if (!updated) return res.status(404).send('Item not found.');
    res.redirect('/menu');
  } catch (err) {
    next(err);
  }
});

app.post('/menu/:id/delete', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const deleted = await menuItems.deleteMenuItem(db, req.session.user.shopId, req.params.id);
    if (!deleted) return res.status(404).send('Item not found.');
    res.redirect('/menu');
  } catch (err) {
    next(err);
  }
});

app.get('/shop/settings', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const shop = await shops.getShopById(db, req.session.user.shopId);
    res.render('shop-settings', { shop, error: null });
  } catch (err) {
    next(err);
  }
});

app.post('/shop/settings', requireAuth, requireRole('owner'), (req, res, next) => {
  upload.single('coverPhoto')(req, res, async (uploadErr) => {
    if (uploadErr) {
      const shop = await shops.getShopById(db, req.session.user.shopId).catch(() => null);
      const message = uploadErr.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 5MB.' : 'Upload failed.';
      return res.render('shop-settings', { shop, error: message });
    }

    const tagline = (req.body.tagline || '').trim() || null;

    try {
      let coverPhotoUrl = null;
      if (req.file) {
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype)) {
          const shop = await shops.getShopById(db, req.session.user.shopId);
          return res.render('shop-settings', { shop, error: 'Please upload a JPG, PNG, or WEBP image.' });
        }
        const ext = req.file.mimetype.split('/')[1];
        const key = `shops/${req.session.user.shopId}/cover-${Date.now()}.${ext}`;
        coverPhotoUrl = await storage.uploadImage(req.file.buffer, key, req.file.mimetype);
      }
      const updated = await shops.updateShopProfile(db, req.session.user.shopId, { tagline, coverPhotoUrl });
      const withOptions = await shops.updatePosOptions(db, req.session.user.shopId, {
        showSize: req.body.posShowSize === 'on',
        showSugar: req.body.posShowSugar === 'on',
        showTemp: req.body.posShowTemp === 'on',
        showNote: req.body.posShowNote === 'on',
      });
      res.render('shop-settings', { shop: withOptions, error: null, saved: true });
    } catch (err) {
      next(err);
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Beanline running at http://localhost:${PORT}`);
  });
}

module.exports = app;
