const express = require('express');
const router = express.Router();
const { query } = require('../db/connection');
const { requireAuth } = require('../middleware/auth');
const { computeTransactionStatus } = require('../services/transactionService');

/**
 * Main dashboard statistics and recent data
 */
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const shopkeeperId = req.shopkeeper.id;
    const todayStr = new Date().toISOString().split('T')[0];

    // Synchronize statuses in case dates have crossed
    await query(
      `UPDATE khata_transactions 
       SET status = 'OVERDUE' 
       WHERE shopkeeper_id = ? AND remaining_balance > 0 AND due_date < ? AND status != 'OVERDUE'`,
      [shopkeeperId, todayStr]
    );

    // 1. Total outstanding credit & Total collected
    const [overallStats] = await query(
      `SELECT 
        COALESCE(SUM(remaining_balance), 0) as total_outstanding,
        COALESCE(SUM(total_paid), 0) as total_collected,
        COUNT(id) as total_transactions
       FROM khata_transactions 
       WHERE shopkeeper_id = ?`,
      [shopkeeperId]
    );

    // 2. Upcoming payments (due in future and remaining_balance > 0)
    const [upcomingStats] = await query(
      `SELECT 
        COUNT(id) as count,
        COALESCE(SUM(remaining_balance), 0) as amount
       FROM khata_transactions 
       WHERE shopkeeper_id = ? AND remaining_balance > 0 AND due_date > ?`,
      [shopkeeperId, todayStr]
    );

    // 3. Payments due today (due_date = today and remaining_balance > 0)
    const [dueTodayStats] = await query(
      `SELECT 
        COUNT(id) as count,
        COALESCE(SUM(remaining_balance), 0) as amount
       FROM khata_transactions 
       WHERE shopkeeper_id = ? AND remaining_balance > 0 AND due_date = ?`,
      [shopkeeperId, todayStr]
    );

    // 4. Overdue payments (due_date < today and remaining_balance > 0)
    const [overdueStats] = await query(
      `SELECT 
        COUNT(id) as count,
        COALESCE(SUM(remaining_balance), 0) as amount
       FROM khata_transactions 
       WHERE shopkeeper_id = ? AND remaining_balance > 0 AND due_date < ?`,
      [shopkeeperId, todayStr]
    );

    // 5. Fully paid transactions
    const [paidStats] = await query(
      `SELECT 
        COUNT(id) as count,
        COALESCE(SUM(original_amount), 0) as amount
       FROM khata_transactions 
       WHERE shopkeeper_id = ? AND remaining_balance = 0`,
      [shopkeeperId]
    );

    // 6. Total customers count
    const [customerCount] = await query(
      `SELECT COUNT(id) as total_customers FROM customers WHERE shopkeeper_id = ?`,
      [shopkeeperId]
    );

    // 7. Recent transactions (last 6)
    const recentTransactions = await query(
      `SELECT kt.*, c.full_name as customer_name, c.phone_number as customer_phone
       FROM khata_transactions kt
       JOIN customers c ON kt.customer_id = c.id
       WHERE kt.shopkeeper_id = ?
       ORDER BY kt.id DESC
       LIMIT 6`,
      [shopkeeperId]
    );

    // 8. Upcoming deadlines (due within next 7 days)
    const upcomingDeadlines = await query(
      `SELECT kt.*, c.full_name as customer_name, c.phone_number as customer_phone,
              DATEDIFF(kt.due_date, ?) as days_left
       FROM khata_transactions kt
       JOIN customers c ON kt.customer_id = c.id
       WHERE kt.shopkeeper_id = ? AND kt.remaining_balance > 0 AND kt.due_date >= ?
       ORDER BY kt.due_date ASC
       LIMIT 5`,
      [todayStr, shopkeeperId, todayStr]
    );

    return res.json({
      success: true,
      summary: {
        totalOutstanding: Number(overallStats.total_outstanding),
        totalCollected: Number(overallStats.total_collected),
        upcomingPayments: {
          count: Number(upcomingStats.count),
          amount: Number(upcomingStats.amount)
        },
        dueToday: {
          count: Number(dueTodayStats.count),
          amount: Number(dueTodayStats.amount)
        },
        overduePayments: {
          count: Number(overdueStats.count),
          amount: Number(overdueStats.amount)
        },
        fullyPaid: {
          count: Number(paidStats.count),
          amount: Number(paidStats.amount)
        },
        totalCustomers: Number(customerCount.total_customers),
        currency: '₹'
      },
      recentTransactions,
      upcomingDeadlines
    });
  } catch (error) {
    console.error('Dashboard summary error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load dashboard: ' + error.message });
  }
});

module.exports = router;

