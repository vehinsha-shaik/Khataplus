const express = require('express');
const router = express.Router();
const { query } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');
const { normalizePhoneNumber } = require('../services/notificationService');

/**
 * List all customers for current shopkeeper with search and outstanding balance
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const shopkeeperId = req.shopkeeper.id;
    const { search } = req.query;

    let sql = `
      SELECT c.*,
             COALESCE(SUM(CASE WHEN kt.remaining_balance > 0 THEN kt.remaining_balance ELSE 0 END), 0) as total_outstanding,
             COUNT(kt.id) as total_transactions,
             MIN(CASE WHEN kt.remaining_balance > 0 AND kt.due_date >= CURDATE() THEN kt.due_date ELSE NULL END) as next_due_date
      FROM customers c
      LEFT JOIN khata_transactions kt ON c.id = kt.customer_id
      WHERE c.shopkeeper_id = ?
    `;
    const params = [shopkeeperId];

    if (search && search.trim()) {
      sql += ' AND (c.full_name LIKE ? OR c.phone_number LIKE ?)';
      params.push(`%${search.trim()}%`, `%${search.trim()}%`);
    }

    sql += ' GROUP BY c.id ORDER BY total_outstanding DESC, c.full_name ASC';

    const customers = await query(sql, params);
    return res.json({ success: true, customers });
  } catch (error) {
    console.error('List customers error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch customers: ' + error.message });
  }
});

/**
 * Get detailed customer profile with full ledger history
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const customerId = req.params.id;
    const shopkeeperId = req.shopkeeper.id;

    // 1. Customer base details
    const custRows = await query(
      'SELECT * FROM customers WHERE id = ? AND shopkeeper_id = ?',
      [customerId, shopkeeperId]
    );

    if (custRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    const customer = custRows[0];

    // 2. Customer transactions
    const transactions = await query(
      `SELECT kt.*,
              DATEDIFF(kt.due_date, CURDATE()) as days_difference
       FROM khata_transactions kt
       WHERE kt.customer_id = ? AND kt.shopkeeper_id = ?
       ORDER BY kt.id DESC`,
      [customerId, shopkeeperId]
    );

    // 3. Payment entries received from this customer
    const payments = await query(
      `SELECT pe.*, kt.purchase_description
       FROM payment_entries pe
       JOIN khata_transactions kt ON pe.transaction_id = kt.id
       WHERE kt.customer_id = ? AND pe.shopkeeper_id = ?
       ORDER BY pe.id DESC`,
      [customerId, shopkeeperId]
    );

    // 4. Notification history
    const notifications = await query(
      `SELECT * FROM notification_logs 
       WHERE customer_id = ? AND shopkeeper_id = ?
       ORDER BY id DESC LIMIT 20`,
      [customerId, shopkeeperId]
    );

    // Aggregate statistics
    let totalCredit = 0;
    let totalPaid = 0;
    let totalOutstanding = 0;
    let nextDueDate = null;

    transactions.forEach(t => {
      totalCredit += Number(t.original_amount);
      totalPaid += Number(t.total_paid);
      totalOutstanding += Number(t.remaining_balance);
      if (Number(t.remaining_balance) > 0) {
        if (!nextDueDate || t.due_date < nextDueDate) {
          nextDueDate = t.due_date;
        }
      }
    });

    return res.json({
      success: true,
      customer: {
        ...customer,
        totalCredit,
        totalPaid,
        totalOutstanding,
        nextDueDate
      },
      transactions,
      payments,
      notifications
    });
  } catch (error) {
    console.error('Customer profile error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch customer profile: ' + error.message });
  }
});

/**
 * Add a new customer (Enforce uniqueness per shopkeeper)
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const shopkeeperId = req.shopkeeper.id;
    const { fullName, phoneNumber, preferredChannel = 'AUTO', address = null, notes = null } = req.body;

    if (!fullName || !phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Customer name and phone number are required.'
      });
    }

    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (!normalizedPhone || normalizedPhone.length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid mobile number with country code.'
      });
    }

    // Check duplicate within the same shop
    const existing = await query(
      'SELECT id, full_name FROM customers WHERE shopkeeper_id = ? AND phone_number = ?',
      [shopkeeperId, normalizedPhone]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: `A customer with this phone number already exists (${existing[0].full_name}).`
      });
    }

    const result = await query(
      `INSERT INTO customers (shopkeeper_id, full_name, phone_number, preferred_channel, address, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [shopkeeperId, fullName.trim(), normalizedPhone, preferredChannel, address, notes]
    );

    return res.status(201).json({
      success: true,
      message: 'Customer created successfully.',
      customer: {
        id: result.insertId,
        shopkeeper_id: shopkeeperId,
        full_name: fullName.trim(),
        phone_number: normalizedPhone,
        preferred_channel: preferredChannel,
        address,
        notes
      }
    });
  } catch (error) {
    console.error('Create customer error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create customer: ' + error.message });
  }
});

/**
 * Update an existing customer
 */
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const customerId = req.params.id;
    const shopkeeperId = req.shopkeeper.id;
    const { fullName, phoneNumber, preferredChannel, address, notes } = req.body;

    let normalizedPhone = undefined;
    if (phoneNumber) {
      normalizedPhone = normalizePhoneNumber(phoneNumber);
      // Ensure phone is not taken by another customer of this shop
      const duplicate = await query(
        'SELECT id FROM customers WHERE shopkeeper_id = ? AND phone_number = ? AND id != ?',
        [shopkeeperId, normalizedPhone, customerId]
      );
      if (duplicate.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Another customer with this phone number already exists in your shop.'
        });
      }
    }

    await query(
      `UPDATE customers 
       SET full_name = COALESCE(?, full_name),
           phone_number = COALESCE(?, phone_number),
           preferred_channel = COALESCE(?, preferred_channel),
           address = COALESCE(?, address),
           notes = COALESCE(?, notes)
       WHERE id = ? AND shopkeeper_id = ?`,
      [fullName ? fullName.trim() : null, normalizedPhone, preferredChannel, address, notes, customerId, shopkeeperId]
    );

    const updated = await query('SELECT * FROM customers WHERE id = ? AND shopkeeper_id = ?', [customerId, shopkeeperId]);

    return res.json({
      success: true,
      message: 'Customer updated successfully.',
      customer: updated[0]
    });
  } catch (error) {
    console.error('Update customer error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update customer: ' + error.message });
  }
});

module.exports = router;
