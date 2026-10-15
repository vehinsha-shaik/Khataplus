const { query, withTransaction } = require('../db/connection');
const { generateOrUpdatePaymentRequest } = require('./paymentService');

/**
 * Determine status based on remaining balance and due date
 */
function computeTransactionStatus(remainingBalance, dueDate) {
  const balance = Number(remainingBalance);
  if (balance <= 0.00) {
    return 'PAID';
  }
  const today = new Date().toISOString().split('T')[0];
  if (dueDate < today) {
    return 'OVERDUE';
  }
  return 'UPCOMING';
}

/**
 * Create a new Khata credit transaction
 */
async function createTransaction({
  shopkeeperId,
  customerId,
  purchaseDescription,
  originalAmount,
  transactionDate,
  dueDate
}) {
  const amount = Number(originalAmount);
  if (isNaN(amount) || amount <= 0) {
    throw new Error('Original amount must be a positive number.');
  }

  const txDate = transactionDate || new Date().toISOString().split('T')[0];
  const due = dueDate || txDate;
  const status = computeTransactionStatus(amount, due);

  return await withTransaction(async (conn) => {
    // 1. Verify customer belongs to shopkeeper
    const [custRows] = await conn.query(
      'SELECT id, full_name, phone_number FROM customers WHERE id = ? AND shopkeeper_id = ?',
      [customerId, shopkeeperId]
    );
    if (custRows.length === 0) {
      throw new Error('Customer not found for this shopkeeper.');
    }

    // 2. Insert transaction
    const [result] = await conn.query(
      `INSERT INTO khata_transactions 
       (shopkeeper_id, customer_id, purchase_description, original_amount, total_paid, remaining_balance, transaction_date, due_date, status)
       VALUES (?, ?, ?, ?, 0.00, ?, ?, ?, ?)`,
      [shopkeeperId, customerId, purchaseDescription, amount, amount, txDate, due, status]
    );

    const transactionId = result.insertId;

    // 3. Log Audit
    await conn.query(
      `INSERT INTO audit_logs (shopkeeper_id, action, entity_type, entity_id, details)
       VALUES (?, 'CREATE_TRANSACTION', 'khata_transactions', ?, ?)`,
      [
        shopkeeperId,
        transactionId,
        JSON.stringify({
          customerId,
          originalAmount: amount,
          remainingBalance: amount,
          dueDate: due,
          description: purchaseDescription
        })
      ]
    );

    return {
      id: transactionId,
      customerId,
      purchaseDescription,
      originalAmount: amount,
      totalPaid: 0.00,
      remainingBalance: amount,
      transactionDate: txDate,
      dueDate: due,
      status
    };
  });
}

/**
 * Record a payment (Full or Partial) - Action 1 & Action 3
 */
async function recordPayment({
  shopkeeperId,
  transactionId,
  paymentAmount,
  paymentMethod = 'CASH',
  paymentReference = null,
  notes = null
}) {
  const payAmt = Number(paymentAmount);
  if (isNaN(payAmt) || payAmt <= 0) {
    throw new Error('Payment amount must be greater than zero.');
  }

  return await withTransaction(async (conn) => {
    // 1. Fetch current transaction with row lock
    const [txRows] = await conn.query(
      'SELECT * FROM khata_transactions WHERE id = ? AND shopkeeper_id = ? FOR UPDATE',
      [transactionId, shopkeeperId]
    );

    if (txRows.length === 0) {
      throw new Error('Transaction not found or unauthorized.');
    }

    const tx = txRows[0];
    const currentRemaining = Number(tx.remaining_balance);

    if (currentRemaining <= 0) {
      throw new Error('This khata transaction is already fully paid.');
    }

    if (payAmt > currentRemaining) {
      throw new Error(`Payment amount (₹${payAmt}) cannot exceed the remaining balance (₹${currentRemaining}).`);
    }

    // 2. Record payment entry
    const [paymentResult] = await conn.query(
      `INSERT INTO payment_entries 
       (transaction_id, shopkeeper_id, amount, payment_method, payment_reference, notes, payment_date)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [transactionId, shopkeeperId, payAmt, paymentMethod, paymentReference, notes]
    );

    // 3. Calculate new totals
    const newTotalPaid = Number(tx.total_paid) + payAmt;
    const newRemaining = Math.max(0, Number(tx.original_amount) - newTotalPaid);
    const newStatus = computeTransactionStatus(newRemaining, tx.due_date);

    // 4. Update transaction
    await conn.query(
      `UPDATE khata_transactions 
       SET total_paid = ?, remaining_balance = ?, status = ?
       WHERE id = ?`,
      [newTotalPaid, newRemaining, newStatus, transactionId]
    );

    // 5. Audit log
    await conn.query(
      `INSERT INTO audit_logs (shopkeeper_id, action, entity_type, entity_id, details)
       VALUES (?, 'RECORD_PAYMENT', 'payment_entries', ?, ?)`,
      [
        shopkeeperId,
        paymentResult.insertId,
        JSON.stringify({
          transactionId,
          paymentAmount: payAmt,
          previousRemaining: currentRemaining,
          newRemaining,
          paymentMethod,
          isFullSettlement: newRemaining === 0
        })
      ]
    );

    return {
      paymentId: paymentResult.insertId,
      transactionId,
      paidAmount: payAmt,
      totalPaid: newTotalPaid,
      remainingBalance: newRemaining,
      status: newStatus,
      isFullyPaid: newRemaining === 0
    };
  });
}

/**
 * Change transaction due date - Action 2
 */
async function changeDueDate({
  shopkeeperId,
  transactionId,
  newDueDate,
  reason = 'Shopkeeper extended deadline'
}) {
  if (!newDueDate) {
    throw new Error('New due date is required.');
  }

  return await withTransaction(async (conn) => {
    // 1. Fetch current transaction with row lock
    const [txRows] = await conn.query(
      'SELECT * FROM khata_transactions WHERE id = ? AND shopkeeper_id = ? FOR UPDATE',
      [transactionId, shopkeeperId]
    );

    if (txRows.length === 0) {
      throw new Error('Transaction not found or unauthorized.');
    }

    const tx = txRows[0];
    const oldDueDate = tx.due_date;

    // Recalculate status based on new deadline and current remaining balance
    const newStatus = computeTransactionStatus(tx.remaining_balance, newDueDate);

    // 2. Update transaction
    await conn.query(
      `UPDATE khata_transactions 
       SET due_date = ?, status = ?
       WHERE id = ?`,
      [newDueDate, newStatus, transactionId]
    );

    // 3. Record adjustment in transaction_adjustments
    await conn.query(
      `INSERT INTO transaction_adjustments 
       (transaction_id, shopkeeper_id, adjustment_type, previous_value, updated_value, reason)
       VALUES (?, ?, 'DUE_DATE_CHANGE', ?, ?, ?)`,
      [transactionId, shopkeeperId, oldDueDate, newDueDate, reason]
    );

    // 4. Audit log
    await conn.query(
      `INSERT INTO audit_logs (shopkeeper_id, action, entity_type, entity_id, details)
       VALUES (?, 'CHANGE_DUE_DATE', 'khata_transactions', ?, ?)`,
      [
        shopkeeperId,
        transactionId,
        JSON.stringify({
          previousDueDate: oldDueDate,
          newDueDate,
          status: newStatus,
          reason
        })
      ]
    );

    return {
      transactionId,
      previousDueDate: oldDueDate,
      newDueDate,
      status: newStatus
    };
  });
}

/**
 * Correct transaction amount with audit trail
 */
async function correctTransactionAmount({
  shopkeeperId,
  transactionId,
  correctedOriginalAmount,
  reason = 'Billing correction'
}) {
  const newOriginal = Number(correctedOriginalAmount);
  if (isNaN(newOriginal) || newOriginal <= 0) {
    throw new Error('Corrected original amount must be a positive number.');
  }

  return await withTransaction(async (conn) => {
    const [txRows] = await conn.query(
      'SELECT * FROM khata_transactions WHERE id = ? AND shopkeeper_id = ? FOR UPDATE',
      [transactionId, shopkeeperId]
    );

    if (txRows.length === 0) {
      throw new Error('Transaction not found or unauthorized.');
    }

    const tx = txRows[0];
    const oldOriginal = Number(tx.original_amount);
    const totalPaid = Number(tx.total_paid);

    if (newOriginal < totalPaid) {
      throw new Error(`Corrected amount (₹${newOriginal}) cannot be less than payments already received (₹${totalPaid}).`);
    }

    const newRemaining = newOriginal - totalPaid;
    const newStatus = computeTransactionStatus(newRemaining, tx.due_date);

    await conn.query(
      `UPDATE khata_transactions 
       SET original_amount = ?, remaining_balance = ?, status = ?
       WHERE id = ?`,
      [newOriginal, newRemaining, newStatus, transactionId]
    );

    await conn.query(
      `INSERT INTO transaction_adjustments 
       (transaction_id, shopkeeper_id, adjustment_type, previous_value, updated_value, reason)
       VALUES (?, ?, 'AMOUNT_CORRECTION', ?, ?, ?)`,
      [transactionId, shopkeeperId, `Original: ₹${oldOriginal}`, `Original: ₹${newOriginal}`, reason]
    );

    await conn.query(
      `INSERT INTO audit_logs (shopkeeper_id, action, entity_type, entity_id, details)
       VALUES (?, 'AMOUNT_CORRECTION', 'khata_transactions', ?, ?)`,
      [
        shopkeeperId,
        transactionId,
        JSON.stringify({
          previousOriginal: oldOriginal,
          correctedOriginal: newOriginal,
          newRemaining,
          reason
        })
      ]
    );

    return {
      transactionId,
      oldOriginal,
      newOriginal,
      totalPaid,
      newRemaining,
      status: newStatus
    };
  });
}

module.exports = {
  computeTransactionStatus,
  createTransaction,
  recordPayment,
  changeDueDate,
  correctTransactionAmount
};

