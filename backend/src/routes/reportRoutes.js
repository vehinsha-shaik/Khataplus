const express = require('express');
const router = express.Router();
const { query } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');

/**
 * Detailed business report
 */
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const shopkeeperId = req.shopkeeper.id;
    const todayStr = new Date().toISOString().split('T')[0];

    const [aggregates] = await query(
      `SELECT 
        COALESCE(SUM(original_amount), 0) as total_credit_given,
        COALESCE(SUM(total_paid), 0) as total_collected,
        COALESCE(SUM(remaining_balance), 0) as total_outstanding,
        COALESCE(SUM(CASE WHEN remaining_balance > 0 AND due_date < ? THEN remaining_balance ELSE 0 END), 0) as total_overdue,
        COALESCE(SUM(CASE WHEN remaining_balance > 0 AND due_date >= ? THEN remaining_balance ELSE 0 END), 0) as upcoming_collections,
        COUNT(id) as total_bills,
        SUM(CASE WHEN remaining_balance = 0 THEN 1 ELSE 0 END) as fully_paid_count,
        SUM(CASE WHEN remaining_balance > 0 AND due_date < ? THEN 1 ELSE 0 END) as overdue_count,
        SUM(CASE WHEN remaining_balance > 0 AND due_date >= ? THEN 1 ELSE 0 END) as upcoming_count
       FROM khata_transactions
       WHERE shopkeeper_id = ?`,
      [todayStr, todayStr, todayStr, todayStr, shopkeeperId]
    );

    // Payment collection by payment method
    const paymentMethods = await query(
      `SELECT payment_method, 
              COUNT(id) as transaction_count,
              COALESCE(SUM(amount), 0) as total_amount
       FROM payment_entries
       WHERE shopkeeper_id = ?
       GROUP BY payment_method`,
      [shopkeeperId]
    );

    // Monthly collection trend (current year)
    const monthlyCollections = await query(
      `SELECT DATE_FORMAT(payment_date, '%Y-%m') as month,
              COALESCE(SUM(amount), 0) as total_collected
       FROM payment_entries
       WHERE shopkeeper_id = ?
       GROUP BY month
       ORDER BY month DESC
       LIMIT 6`,
      [shopkeeperId]
    );

    return res.json({
      success: true,
      report: {
        financials: {
          totalCreditGiven: Number(aggregates.total_credit_given),
          totalCollected: Number(aggregates.total_collected),
          totalOutstanding: Number(aggregates.total_outstanding),
          totalOverdue: Number(aggregates.total_overdue),
          upcomingCollections: Number(aggregates.upcoming_collections)
        },
        counts: {
          totalBills: Number(aggregates.total_bills),
          fullyPaid: Number(aggregates.fully_paid_count || 0),
          overdue: Number(aggregates.overdue_count || 0),
          upcoming: Number(aggregates.upcoming_count || 0)
        },
        paymentMethods,
        monthlyCollections
      }
    });
  } catch (error) {
    console.error('Report summary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate report: ' + error.message });
  }
});

/**
 * Customer-wise outstanding balances report
 */
router.get('/customer-balances', requireAuth, async (req, res) => {
  try {
    const shopkeeperId = req.shopkeeper.id;

    const customers = await query(
      `SELECT c.id, c.full_name, c.phone_number, c.preferred_channel,
              COALESCE(SUM(kt.original_amount), 0) as total_credit,
              COALESCE(SUM(kt.total_paid), 0) as total_paid,
              COALESCE(SUM(kt.remaining_balance), 0) as outstanding_balance,
              COUNT(kt.id) as total_transactions,
              MIN(CASE WHEN kt.remaining_balance > 0 THEN kt.due_date ELSE NULL END) as earliest_due_date
       FROM customers c
       LEFT JOIN khata_transactions kt ON c.id = kt.customer_id
       WHERE c.shopkeeper_id = ?
       GROUP BY c.id
       ORDER BY outstanding_balance DESC, c.full_name ASC`,
      [shopkeeperId]
    );

    return res.json({
      success: true,
      customers
    });
  } catch (error) {
    console.error('Customer balances report error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch customer balances: ' + error.message });
  }
});

/**
 * Audit log of financial & transaction activities
 */
router.get('/audit-logs', requireAuth, async (req, res) => {
  try {
    const shopkeeperId = req.shopkeeper.id;
    const limit = parseInt(req.query.limit || '50', 10);

    const logs = await query(
      `SELECT * FROM audit_logs 
       WHERE shopkeeper_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [shopkeeperId, limit]
    );

    return res.json({
      success: true,
      logs
    });
  } catch (error) {
    console.error('Audit logs error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch audit logs: ' + error.message });
  }
});

module.exports = router;

