// middleware/auth.js
const db = require('../db');
const shops = require('../models/shops');

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).send('Forbidden: this page requires a ' + roles.join(' or ') + ' account.');
    }
    next();
  };
}

async function loadShopBySlug(req, res, next) {
  try {
    const shop = await shops.getShopBySlug(db, req.params.shopSlug);
    if (!shop) return res.status(404).send('Shop not found.');
    req.shop = shop;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, requireRole, loadShopBySlug };
