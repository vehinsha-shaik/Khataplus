const jwt = require('jsonwebtoken');
const { query } = require('../db/connection');

const JWT_SECRET = process.env.JWT_SECRET || 'khata_plus_secure_jwt_token_secret_key_2026_production';

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token missing or invalid.'
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const rows = await query(
      'SELECT id, shop_name, owner_name, phone_number, upi_id, language_preference, reminder_days_before, auto_reminders_enabled FROM shopkeepers WHERE id = ?',
      [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Shopkeeper account not found or has been deactivated.'
      });
    }

    req.shopkeeper = rows[0];
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please log in again.'
      });
    }
    return res.status(401).json({
      success: false,
      message: 'Invalid session token.'
    });
  }
}

function generateToken(shopkeeper) {
  return jwt.sign(
    {
      id: shopkeeper.id,
      phone_number: shopkeeper.phone_number
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

module.exports = {
  requireAuth,
  generateToken,
  JWT_SECRET
};

