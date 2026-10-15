const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query } = require('../db/connection');
const { requireAuth, generateToken } = require('../middleware/auth');
const { isValidUpiId } = require('../services/paymentService');

/**
 * Register a new shopkeeper
 */
router.post('/register', async (req, res) => {
  try {
    const { shopName, ownerName, phoneNumber, password, upiId, languagePreference = 'en', reminderDaysBefore = 2 } = req.body;

    if (!shopName || !ownerName || !phoneNumber || !password || !upiId) {
      return res.status(400).json({
        success: false,
        message: 'All fields (shopName, ownerName, phoneNumber, password, upiId) are required.'
      });
    }

    if (!isValidUpiId(upiId)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid shopkeeper UPI ID (e.g., yourshop@ybl, 9876543210@axl).'
      });
    }

    const cleanPhone = phoneNumber.trim().replace(/[^\d]/g, '').slice(-10);
    if (cleanPhone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid 10-digit mobile number.'
      });
    }

    // Check existing phone
    const existing = await query('SELECT id FROM shopkeepers WHERE phone_number = ?', [cleanPhone]);
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'A shopkeeper account with this mobile number already exists.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO shopkeepers 
       (shop_name, owner_name, phone_number, password_hash, upi_id, language_preference, reminder_days_before)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [shopName.trim(), ownerName.trim(), cleanPhone, passwordHash, upiId.trim(), languagePreference, reminderDaysBefore]
    );

    const newShopkeeper = {
      id: result.insertId,
      shop_name: shopName.trim(),
      owner_name: ownerName.trim(),
      phone_number: cleanPhone,
      upi_id: upiId.trim(),
      language_preference: languagePreference,
      reminder_days_before: reminderDaysBefore
    };

    const token = generateToken(newShopkeeper);

    return res.status(201).json({
      success: true,
      message: 'Shopkeeper registered successfully.',
      token,
      shopkeeper: newShopkeeper
    });
  } catch (error) {
    console.error('Registration error:', error);
    return res.status(500).json({ success: false, message: 'Server error during registration: ' + error.message });
  }
});

/**
 * Login shopkeeper
 */
router.post('/login', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body;

    if (!phoneNumber || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide both mobile number and password.'
      });
    }

    const cleanPhone = phoneNumber.trim().replace(/[^\d]/g, '').slice(-10);
    const rows = await query('SELECT * FROM shopkeepers WHERE phone_number = ?', [cleanPhone]);

    if (rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid phone number or password.'
      });
    }

    const shopkeeper = rows[0];
    const passwordMatch = await bcrypt.compare(password, shopkeeper.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid phone number or password.'
      });
    }

    const token = generateToken(shopkeeper);

    const safeShopkeeper = {
      id: shopkeeper.id,
      shop_name: shopkeeper.shop_name,
      owner_name: shopkeeper.owner_name,
      phone_number: shopkeeper.phone_number,
      upi_id: shopkeeper.upi_id,
      language_preference: shopkeeper.language_preference,
      reminder_days_before: shopkeeper.reminder_days_before,
      auto_reminders_enabled: Boolean(shopkeeper.auto_reminders_enabled)
    };

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      shopkeeper: safeShopkeeper
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, message: 'Server error during login: ' + error.message });
  }
});

/**
 * Get current authenticated shopkeeper
 */
router.get('/me', requireAuth, (req, res) => {
  return res.json({
    success: true,
    shopkeeper: req.shopkeeper
  });
});

/**
 * Update shop profile and preferences
 */
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { shopName, ownerName, upiId, languagePreference, reminderDaysBefore, autoRemindersEnabled } = req.body;

    if (upiId && !isValidUpiId(upiId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid UPI ID format. Please provide a valid UPI ID (e.g. shop@ybl).'
      });
    }

    await query(
      `UPDATE shopkeepers 
       SET shop_name = COALESCE(?, shop_name),
           owner_name = COALESCE(?, owner_name),
           upi_id = COALESCE(?, upi_id),
           language_preference = COALESCE(?, language_preference),
           reminder_days_before = COALESCE(?, reminder_days_before),
           auto_reminders_enabled = COALESCE(?, auto_reminders_enabled)
       WHERE id = ?`,
      [shopName, ownerName, upiId, languagePreference, reminderDaysBefore, autoRemindersEnabled, req.shopkeeper.id]
    );

    const [updated] = await query(
      'SELECT id, shop_name, owner_name, phone_number, upi_id, language_preference, reminder_days_before, auto_reminders_enabled FROM shopkeepers WHERE id = ?',
      [req.shopkeeper.id]
    );

    return res.json({
      success: true,
      message: 'Profile updated successfully.',
      shopkeeper: updated
    });
  } catch (error) {
    console.error('Profile update error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update profile: ' + error.message });
  }
});

/**
 * Provider status (Transparent messaging setup verification)
 */
router.get('/provider-status', requireAuth, (req, res) => {
  const whatsappConfigured = Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
  const smsFast2SmsConfigured = Boolean(process.env.SMS_API_KEY);
  const smsTwilioConfigured = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

  return res.json({
    success: true,
    whatsapp: {
      isConfigured: whatsappConfigured,
      provider: 'WhatsApp Business Cloud API',
      status: whatsappConfigured ? 'CONNECTED' : 'NOT_CONFIGURED (Direct wa.me links available)'
    },
    sms: {
      isConfigured: smsFast2SmsConfigured || smsTwilioConfigured,
      provider: smsFast2SmsConfigured ? 'Fast2SMS' : smsTwilioConfigured ? 'Twilio' : 'SMS Gateway',
      status: smsFast2SmsConfigured || smsTwilioConfigured ? 'CONNECTED' : 'NOT_CONFIGURED (Direct device intent available)'
    },
    upi: {
      isConfigured: Boolean(req.shopkeeper.upi_id),
      payeeUpiId: req.shopkeeper.upi_id,
      status: 'VERIFIED'
    }
  });
});

module.exports = router;

