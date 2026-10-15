const express = require('express');
const router = express.Router();
const { query } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');
const {
  createTransaction,
  recordPayment,
  changeDueDate,
  correctTransactionAmount,
  computeTransactionStatus
} = require('../services/transactionService');
const {
  generateOrUpdatePaymentRequest,
  getActivePaymentRequest
} = require('../services/paymentService');
const {
  sendTransactionReminder,
  TEMPLATES,
  buildMessage
} = require('../services/notificationService');

/**
 * List transactions filtered by category (upcoming, overdue, paid) or search
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const shopkeeperId = req.shopkeeper.id;
    const { category, search, customerId } = req.query;
    const todayStr = new Date().toISOString().split('T')[0];

    // Refresh overdue statuses automatically
    await query(
      `UPDATE khata_transactions 
       SET status = 'OVERDUE' 
       WHERE shopkeeper_id = ? AND remaining_balance > 0 AND due_date < ? AND status != 'OVERDUE'`,
      [shopkeeperId, todayStr]
    );

    let sql = `
      SELECT kt.*,
             c.full_name as customer_name,
             c.phone_number as customer_phone,
             c.preferred_channel as customer_channel,
             DATEDIFF(kt.due_date, ?) as days_until_due,
             (
               SELECT pe.payment_method 
               FROM payment_entries pe 
               WHERE pe.transaction_id = kt.id 
               ORDER BY pe.id DESC LIMIT 1
             ) as last_payment_method,
             (
               SELECT pe.payment_date 
               FROM payment_entries pe 
               WHERE pe.transaction_id = kt.id 
               ORDER BY pe.id DESC LIMIT 1
             ) as last_payment_date
      FROM khata_transactions kt
      JOIN customers c ON kt.customer_id = c.id
      WHERE kt.shopkeeper_id = ?
    `;
    const params = [todayStr, shopkeeperId];

    // Category filter
    if (category === 'upcoming') {
      sql += ' AND kt.remaining_balance > 0 AND kt.due_date >= ?';
      params.push(todayStr);
    } else if (category === 'overdue') {
      sql += ' AND kt.remaining_balance > 0 AND kt.due_date < ?';
      params.push(todayStr);
    } else if (category === 'paid') {
      sql += ' AND kt.remaining_balance = 0';
    }

    // Specific customer filter
    if (customerId) {
      sql += ' AND kt.customer_id = ?';
      params.push(customerId);
    }

    // Search filter across customer name, phone, or shopping description
    if (search && search.trim()) {
      const q = `%${search.trim()}%`;
      sql += ' AND (c.full_name LIKE ? OR c.phone_number LIKE ? OR kt.purchase_description LIKE ?)';
      params.push(q, q, q);
    }

    // Ordering
    if (category === 'upcoming') {
      sql += ' ORDER BY kt.due_date ASC, kt.id DESC';
    } else if (category === 'overdue') {
      sql += ' ORDER BY kt.due_date ASC, kt.remaining_balance DESC';
    } else if (category === 'paid') {
      sql += ' ORDER BY kt.updated_at DESC, kt.id DESC';
    } else {
      sql += ' ORDER BY kt.id DESC';
    }

    const transactions = await query(sql, params);

    return res.json({
      success: true,
      category: category || 'all',
      count: transactions.length,
      transactions
    });
  } catch (error) {
    console.error('List transactions error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch transactions: ' + error.message });
  }
});

/**
 * Get single transaction details with full audit & payment history
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const txId = req.params.id;
    const shopkeeperId = req.shopkeeper.id;
    const todayStr = new Date().toISOString().split('T')[0];

    const txRows = await query(
      `SELECT kt.*,
              c.full_name as customer_name,
              c.phone_number as customer_phone,
              c.preferred_channel as customer_channel,
              c.address as customer_address,
              DATEDIFF(kt.due_date, ?) as days_until_due
       FROM khata_transactions kt
       JOIN customers c ON kt.customer_id = c.id
       WHERE kt.id = ? AND kt.shopkeeper_id = ?`,
      [todayStr, txId, shopkeeperId]
    );

    if (txRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    const transaction = txRows[0];

    // Fetch payments list
    const payments = await query(
      `SELECT * FROM payment_entries WHERE transaction_id = ? AND shopkeeper_id = ? ORDER BY id DESC`,
      [txId, shopkeeperId]
    );

    // Fetch adjustments history (Audit of due date changes, amount changes)
    const adjustments = await query(
      `SELECT * FROM transaction_adjustments WHERE transaction_id = ? AND shopkeeper_id = ? ORDER BY id DESC`,
      [txId, shopkeeperId]
    );

    // Fetch reminder history
    const reminders = await query(
      `SELECT * FROM notification_logs WHERE transaction_id = ? AND shopkeeper_id = ? ORDER BY id DESC`,
      [txId, shopkeeperId]
    );

    // Fetch active payment request (PhonePe deep link and QR code)
    let paymentRequest = null;
    if (transaction.remaining_balance > 0) {
      paymentRequest = await getActivePaymentRequest(txId, shopkeeperId);
      if (!paymentRequest) {
        paymentRequest = await generateOrUpdatePaymentRequest(txId, req.shopkeeper);
      }
    }

    return res.json({
      success: true,
      transaction,
      payments,
      adjustments,
      reminders,
      paymentRequest
    });
  } catch (error) {
    console.error('Get transaction details error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch transaction: ' + error.message });
  }
});

/**
 * Create a new Khata credit transaction
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { customerId, purchaseDescription, originalAmount, transactionDate, dueDate } = req.body;

    if (!customerId || !purchaseDescription || !originalAmount) {
      return res.status(400).json({
        success: false,
        message: 'Customer, purchase description, and credit amount are required.'
      });
    }

    const newTx = await createTransaction({
      shopkeeperId: req.shopkeeper.id,
      customerId,
      purchaseDescription: purchaseDescription.trim(),
      originalAmount,
      transactionDate,
      dueDate
    });

    // Generate initial PhonePe payment link & QR code
    const payReq = await generateOrUpdatePaymentRequest(newTx.id, req.shopkeeper);

    return res.status(201).json({
      success: true,
      message: 'Khata transaction created successfully.',
      transaction: newTx,
      paymentRequest: payReq
    });
  } catch (error) {
    console.error('Create transaction error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create transaction: ' + error.message });
  }
});

/**
 * ACTION 1 & ACTION 3: Record Payment (Full or Partial)
 */
router.post('/:id/pay', requireAuth, async (req, res) => {
  try {
    const txId = req.params.id;
    const { amount, paymentMethod = 'CASH', paymentReference = null, notes = null, isFullPayment = false } = req.body;

    // Fetch current transaction
    const txRows = await query(
      'SELECT remaining_balance, original_amount FROM khata_transactions WHERE id = ? AND shopkeeper_id = ?',
      [txId, req.shopkeeper.id]
    );

    if (txRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found.' });
    }

    const tx = txRows[0];
    const payAmount = isFullPayment ? Number(tx.remaining_balance) : Number(amount);

    if (!payAmount || payAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid payment amount is required.' });
    }

    const paymentResult = await recordPayment({
      shopkeeperId: req.shopkeeper.id,
      transactionId: txId,
      paymentAmount: payAmount,
      paymentMethod,
      paymentReference,
      notes
    });

    // If remaining balance is still > 0, regenerate QR code for the new remaining amount!
    let updatedPaymentRequest = null;
    if (paymentResult.remainingBalance > 0) {
      updatedPaymentRequest = await generateOrUpdatePaymentRequest(txId, req.shopkeeper);
    }

    return res.json({
      success: true,
      message: paymentResult.isFullyPaid
        ? 'Transaction fully paid! Moved to Paid section.'
        : `Partial payment of ₹${payAmount} recorded. Remaining balance: ₹${paymentResult.remainingBalance}.`,
      result: paymentResult,
      updatedPaymentRequest
    });
  } catch (error) {
    console.error('Record payment error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * ACTION 2: Change Due Date
 */
router.put('/:id/due-date', requireAuth, async (req, res) => {
  try {
    const txId = req.params.id;
    const { newDueDate, reason } = req.body;

    if (!newDueDate) {
      return res.status(400).json({ success: false, message: 'New due date is required.' });
    }

    const result = await changeDueDate({
      shopkeeperId: req.shopkeeper.id,
      transactionId: txId,
      newDueDate,
      reason
    });

    return res.json({
      success: true,
      message: `Due date updated to ${newDueDate}. Status is now ${result.status}.`,
      result
    });
  } catch (error) {
    console.error('Change due date error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Audited Amount Correction
 */
router.post('/:id/correct-amount', requireAuth, async (req, res) => {
  try {
    const txId = req.params.id;
    const { correctedAmount, reason } = req.body;

    if (!correctedAmount || Number(correctedAmount) <= 0) {
      return res.status(400).json({ success: false, message: 'Corrected amount must be greater than zero.' });
    }

    const result = await correctTransactionAmount({
      shopkeeperId: req.shopkeeper.id,
      transactionId: txId,
      correctedOriginalAmount: correctedAmount,
      reason: reason || 'Shopkeeper corrected bill amount'
    });

    // Regenerate QR code if remaining balance is positive
    let updatedPaymentRequest = null;
    if (result.newRemaining > 0) {
      updatedPaymentRequest = await generateOrUpdatePaymentRequest(txId, req.shopkeeper);
    }

    return res.json({
      success: true,
      message: `Transaction amount corrected to ₹${correctedAmount}. Remaining balance: ₹${result.newRemaining}.`,
      result,
      updatedPaymentRequest
    });
  } catch (error) {
    console.error('Correct amount error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Send WhatsApp or SMS Reminder
 */
router.post('/:id/send-reminder', requireAuth, async (req, res) => {
  try {
    const txId = req.params.id;
    const { channel, language, reminderType = 'MANUAL' } = req.body;

    const result = await sendTransactionReminder({
      transactionId: txId,
      shopkeeper: req.shopkeeper,
      reminderType,
      forceChannel: channel || null,
      overrideLanguage: language || null
    });

    if (result.suppressed) {
      return res.json({
        success: false,
        suppressed: true,
        message: result.message
      });
    }

    return res.json({
      success: true,
      message: `Reminder generated for ${result.channel} (${result.language.toUpperCase()}).`,
      details: result
    });
  } catch (error) {
    console.error('Send reminder error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Get / Refresh UPI payment request and PhonePe QR code
 */
router.get('/:id/payment-request', requireAuth, async (req, res) => {
  try {
    const txId = req.params.id;
    const payReq = await generateOrUpdatePaymentRequest(txId, req.shopkeeper);

    if (!payReq) {
      return res.status(400).json({
        success: false,
        message: 'No active payment request. Transaction is already settled.'
      });
    }

    return res.json({
      success: true,
      paymentRequest: payReq
    });
  } catch (error) {
    console.error('Get payment request error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
