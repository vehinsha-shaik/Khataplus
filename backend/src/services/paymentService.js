const QRCode = require('qrcode');
const crypto = require('crypto');
const { query } = require('../db/connection');

/**
 * Validates UPI ID format (e.g., username@bank, 9876543210@ybl, etc.)
 */
function isValidUpiId(upiId) {
  if (!upiId || typeof upiId !== 'string') return false;
  const upiRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
  return upiRegex.test(upiId.trim());
}

/**
 * Generate standard UPI deep link and PhonePe specific intent URL
 */
function generateUpiLinks({ payeeUpiId, payeeName, amount, note, referenceId }) {
  const formattedAmount = Number(amount).toFixed(2);
  const cleanUpiId = payeeUpiId.trim();
  const cleanName = payeeName.trim();
  const cleanNote = (note || 'Khata Plus Udhaar Payment').substring(0, 50).trim();

  // Standard generic UPI intent URI
  const params = new URLSearchParams();
  params.append('pa', cleanUpiId);
  params.append('pn', cleanName);
  params.append('am', formattedAmount);
  params.append('cu', 'INR');
  params.append('tn', cleanNote);
  if (referenceId) {
    params.append('tr', referenceId);
  }

  const standardUpiUrl = `upi://pay?${params.toString()}`;

  // PhonePe specific intent URI (Supported on Android and iOS when PhonePe is registered for phonepe:// or UPI scheme with package)
  const phonepeIntentUrl = `phonepe://pay?${params.toString()}`;

  return {
    standardUpiUrl,
    phonepeIntentUrl,
    formattedAmount
  };
}

/**
 * Generate or update a dynamic Payment Request for a khata transaction
 */
async function generateOrUpdatePaymentRequest(transactionId, shopkeeper) {
  // 1. Fetch current transaction details
  const rows = await query(
    `SELECT kt.*, c.full_name as customer_name, c.phone_number as customer_phone
     FROM khata_transactions kt
     JOIN customers c ON kt.customer_id = c.id
     WHERE kt.id = ? AND kt.shopkeeper_id = ?`,
    [transactionId, shopkeeper.id]
  );

  if (!rows || rows.length === 0) {
    throw new Error('Transaction not found or unauthorized');
  }

  const tx = rows[0];

  const remainingBalance = Number(tx.remaining_balance);
  if (remainingBalance <= 0) {
    // If balance is 0, update any pending request to EXPIRED/CANCELLED
    await query(
      `UPDATE payment_requests SET status = 'CANCELLED' WHERE transaction_id = ? AND status = 'PENDING'`,
      [transactionId]
    );
    return null;
  }

  // 2. Generate unique reference ID
  const referenceId = `KP_${tx.id}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`.toUpperCase();
  const note = `Khata Bill #${tx.id} - ${tx.customer_name}`.substring(0, 40);

  const { standardUpiUrl, phonepeIntentUrl } = generateUpiLinks({
    payeeUpiId: shopkeeper.upi_id,
    payeeName: shopkeeper.shop_name,
    amount: remainingBalance,
    note,
    referenceId
  });

  // 3. Generate High-Quality QR Code (Data URL)
  const qrCodeDataUrl = await QRCode.toDataURL(standardUpiUrl, {
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 320,
    color: {
      dark: '#1B2559',
      light: '#FFFFFF'
    }
  });

  // 4. Invalidate older pending requests for this transaction
  await query(
    `UPDATE payment_requests SET status = 'EXPIRED' WHERE transaction_id = ? AND status = 'PENDING'`,
    [transactionId]
  );

  // 5. Store newly generated payment request
  const result = await query(
    `INSERT INTO payment_requests 
     (transaction_id, shopkeeper_id, reference_id, payee_upi_id, payee_name, requested_amount, upi_intent_url, phonepe_intent_url, qr_code_data_url, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
    [
      transactionId,
      shopkeeper.id,
      referenceId,
      shopkeeper.upi_id,
      shopkeeper.shop_name,
      remainingBalance,
      standardUpiUrl,
      phonepeIntentUrl,
      qrCodeDataUrl
    ]
  );

  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5000';
  const publicPayUrl = `${baseUrl}/pay/${referenceId}`;

  return {
    id: result.insertId,
    referenceId,
    transactionId,
    payeeUpiId: shopkeeper.upi_id,
    payeeName: shopkeeper.shop_name,
    requestedAmount: remainingBalance,
    standardUpiUrl,
    phonepeIntentUrl,
    qrCodeDataUrl,
    publicPayUrl,
    status: 'PENDING'
  };
}

/**
 * Get active payment request for transaction
 */
async function getActivePaymentRequest(transactionId, shopkeeperId) {
  const rows = await query(
    `SELECT * FROM payment_requests 
     WHERE transaction_id = ? AND shopkeeper_id = ? AND status = 'PENDING'
     ORDER BY id DESC LIMIT 1`,
    [transactionId, shopkeeperId]
  );

  if (rows.length === 0) return null;

  const req = rows[0];
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5000';
  return {
    ...req,
    referenceId: req.reference_id,
    phonepeIntentUrl: req.phonepe_intent_url,
    standardUpiUrl: req.upi_intent_url,
    requestedAmount: req.requested_amount,
    qrCodeDataUrl: req.qr_code_data_url,
    publicPayUrl: `${baseUrl}/pay/${req.reference_id}`
  };
}

module.exports = {
  isValidUpiId,
  generateUpiLinks,
  generateOrUpdatePaymentRequest,
  getActivePaymentRequest
};
