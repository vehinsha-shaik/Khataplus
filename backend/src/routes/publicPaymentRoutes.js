const express = require('express');
const router = express.Router();
const { query } = require('../db/connection');

/**
 * Public Payment Landing Page for customers
 */
router.get('/:referenceId', async (req, res) => {
  try {
    const { referenceId } = req.params;

    const rows = await query(
      `SELECT pr.*, 
              kt.purchase_description, kt.due_date, kt.remaining_balance, kt.status as tx_status,
              s.shop_name, s.owner_name, s.phone_number as shop_phone, s.upi_id,
              c.full_name as customer_name
       FROM payment_requests pr
       JOIN khata_transactions kt ON pr.transaction_id = kt.id
       JOIN shopkeepers s ON pr.shopkeeper_id = s.id
       JOIN customers c ON kt.customer_id = c.id
       WHERE pr.reference_id = ?`,
      [referenceId]
    );

    if (rows.length === 0) {
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Payment Link Expired - Khata Plus</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; }
            .card { background: #fff; border-radius: 16px; padding: 32px; max-width: 420px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.06); }
            h2 { color: #e11d48; margin-top: 0; }
            p { color: #64748b; line-height: 1.6; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Payment Link Expired or Not Found</h2>
            <p>This payment link is no longer valid. The balance may have been settled or updated. Please contact the shopkeeper for an updated payment request.</p>
          </div>
        </body>
        </html>
      `);
    }

    const payData = rows[0];
    const isPaid = payData.tx_status === 'PAID' || Number(payData.remaining_balance) <= 0;
    const amount = Number(payData.remaining_balance > 0 ? payData.remaining_balance : payData.requested_amount).toFixed(2);

    // Encode UPI params
    const upiParams = new URLSearchParams();
    upiParams.append('pa', payData.upi_id);
    upiParams.append('pn', payData.shop_name);
    upiParams.append('am', amount);
    upiParams.append('cu', 'INR');
    upiParams.append('tn', `Khata #${payData.transaction_id} ${payData.customer_name}`.substring(0, 45));
    upiParams.append('tr', payData.reference_id);

    const standardUpiUrl = `upi://pay?${upiParams.toString()}`;
    const phonepeIntentUrl = `phonepe://pay?${upiParams.toString()}`;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Pay ₹${amount} to ${payData.shop_name} - Khata Plus</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
        <style>
          * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
          body {
            font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0f172a;
            color: #f8fafc;
            margin: 0;
            padding: 20px 16px;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
          }
          .container {
            width: 100%;
            max-width: 440px;
            background: #1e293b;
            border: 1px solid #334155;
            border-radius: 24px;
            padding: 28px 24px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          }
          .brand-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: rgba(99, 102, 241, 0.15);
            color: #818cf8;
            font-size: 12px;
            font-weight: 700;
            padding: 6px 12px;
            border-radius: 9999px;
            margin-bottom: 20px;
            letter-spacing: 0.5px;
          }
          .shop-title {
            font-size: 22px;
            font-weight: 800;
            color: #ffffff;
            margin: 0 0 6px 0;
            line-height: 1.3;
          }
          .payee-upi {
            font-size: 13px;
            color: #94a3b8;
            margin: 0 0 20px 0;
            display: flex;
            align-items: center;
            gap: 4px;
          }
          .verified-icon {
            color: #22c55e;
            font-weight: bold;
          }
          .amount-box {
            background: linear-gradient(135deg, #312e81 0%, #1e1b4b 100%);
            border: 1px solid #4338ca;
            border-radius: 20px;
            padding: 22px 20px;
            text-align: center;
            margin-bottom: 24px;
          }
          .amount-label {
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #c7d2fe;
            margin-bottom: 6px;
          }
          .amount-val {
            font-size: 38px;
            font-weight: 800;
            color: #ffffff;
            letter-spacing: -1px;
          }
          .bill-meta {
            font-size: 13px;
            color: #cbd5e1;
            margin-top: 10px;
            background: rgba(0,0,0,0.2);
            padding: 8px 12px;
            border-radius: 10px;
          }
          .btn-group {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 24px;
          }
          .btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            text-decoration: none;
            font-size: 16px;
            font-weight: 700;
            padding: 16px 20px;
            border-radius: 16px;
            border: none;
            cursor: pointer;
            transition: all 0.2s ease;
          }
          .btn-phonepe {
            background: #5f259f;
            color: #ffffff;
            box-shadow: 0 8px 20px rgba(95, 37, 159, 0.4);
          }
          .btn-phonepe:hover {
            background: #6e2cb8;
            transform: translateY(-1px);
          }
          .btn-upi {
            background: #2563eb;
            color: #ffffff;
            box-shadow: 0 8px 20px rgba(37, 99, 235, 0.35);
          }
          .btn-upi:hover {
            background: #1d4ed8;
            transform: translateY(-1px);
          }
          .qr-section {
            background: #ffffff;
            border-radius: 20px;
            padding: 20px;
            text-align: center;
            margin-bottom: 20px;
          }
          .qr-img {
            width: 220px;
            height: 220px;
            margin: 0 auto;
            display: block;
          }
          .qr-hint {
            color: #475569;
            font-size: 12px;
            font-weight: 600;
            margin-top: 10px;
          }
          .footer-note {
            font-size: 12px;
            color: #64748b;
            text-align: center;
            line-height: 1.6;
          }
          .status-paid {
            background: #064e3b;
            border: 1px solid #059669;
            color: #34d399;
            padding: 20px;
            border-radius: 16px;
            text-align: center;
            font-weight: 700;
            font-size: 18px;
            margin-bottom: 20px;
          }
          .confirm-box {
            margin-top: 16px;
            padding-top: 16px;
            border-top: 1px dashed #334155;
          }
          .confirm-input {
            width: 100%;
            padding: 12px;
            border-radius: 10px;
            border: 1px solid #475569;
            background: #0f172a;
            color: #ffffff;
            font-size: 14px;
            margin-bottom: 10px;
          }
          .btn-submit-ref {
            width: 100%;
            background: #334155;
            color: #f1f5f9;
            border: none;
            padding: 12px;
            border-radius: 10px;
            font-weight: 600;
            cursor: pointer;
          }
          .btn-submit-ref:hover {
            background: #475569;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="brand-badge">
            <span style="display:inline-block;width:8px;height:8px;background:#818cf8;border-radius:50%"></span>
            KHATA PLUS &bull; SMART CREDIT LEDGER
          </div>

          <h1 class="shop-title">${payData.shop_name}</h1>
          <div class="payee-upi">
            <span class="verified-icon">✓</span> Verified Shop UPI: <strong style="color:#e2e8f0;margin-left:4px;">${payData.upi_id}</strong>
          </div>

          ${
            isPaid
              ? `<div class="status-paid">✓ This Khata Bill is Fully Settled! Thank You.</div>`
              : `
              <div class="amount-box">
                <div class="amount-label">Outstanding Balance Due</div>
                <div class="amount-val">₹${amount}</div>
                <div class="bill-meta">
                  Bill Details: <strong>${payData.purchase_description}</strong><br>
                  Customer: <strong>${payData.customer_name}</strong> | Due: <strong>${payData.due_date}</strong>
                </div>
              </div>

              <div class="btn-group">
                <!-- PhonePe Direct App Intent -->
                <a href="${phonepeIntentUrl}" class="btn btn-phonepe">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                  Pay with PhonePe
                </a>

                <!-- Standard All UPI Apps -->
                <a href="${standardUpiUrl}" class="btn btn-upi">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                  Pay with Any UPI App (GPay / Paytm / BHIM)
                </a>
              </div>

              <!-- Payment QR Code for desktop or another phone -->
              <div class="qr-section">
                <img src="${payData.qr_code_data_url}" alt="PhonePe UPI Payment QR Code" class="qr-img" />
                <div class="qr-hint">Scan with PhonePe, GPay, Paytm or Any UPI App to Pay ₹${amount}</div>
              </div>

              <div class="confirm-box">
                <div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">Paid using UPI? Enter UTR / Reference No. to notify shopkeeper:</div>
                <form id="refForm" onsubmit="submitRef(event)">
                  <input type="text" id="refInput" class="confirm-input" placeholder="e.g. 423982194821 (12-digit UPI Ref)" required />
                  <button type="submit" class="btn-submit-ref" id="refBtn">Submit Payment Proof</button>
                  <div id="refMsg" style="font-size:12px;margin-top:6px;display:none;"></div>
                </form>
              </div>
              `
          }

          <div class="footer-note" style="margin-top:20px;">
            Shop Contact: ${payData.shop_phone} &bull; Owner: ${payData.owner_name}<br>
            Cash payments can also be made directly at the shop.<br>
            Powered securely by <strong>Khata Plus</strong>. No app installation needed.
          </div>
        </div>

        <script>
          async function submitRef(e) {
            e.preventDefault();
            const refVal = document.getElementById('refInput').value.trim();
            const btn = document.getElementById('refBtn');
            const msg = document.getElementById('refMsg');
            if (!refVal) return;
            btn.disabled = true;
            btn.innerText = 'Submitting...';

            try {
              const res = await fetch('/pay/${payData.reference_id}/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ upiReference: refVal })
              });
              const json = await res.json();
              msg.style.display = 'block';
              if (json.success) {
                msg.style.color = '#34d399';
                msg.innerText = 'Payment proof submitted! Shopkeeper will verify receipt.';
                btn.style.display = 'none';
                document.getElementById('refInput').style.display = 'none';
              } else {
                msg.style.color = '#f87171';
                msg.innerText = json.message || 'Submission failed.';
                btn.disabled = false;
                btn.innerText = 'Submit Payment Proof';
              }
            } catch(err) {
              msg.style.display = 'block';
              msg.style.color = '#f87171';
              msg.innerText = 'Network error. Please try again.';
              btn.disabled = false;
              btn.innerText = 'Submit Payment Proof';
            }
          }
        </script>
      </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    console.error('Customer payment page error:', error);
    res.status(500).send('Internal Server Error: ' + error.message);
  }
});

/**
 * Customer submits payment reference / webhook confirmation
 */
router.post('/:referenceId/confirm', async (req, res) => {
  try {
    const { referenceId } = req.params;
    const { upiReference } = req.body;

    const rows = await query(
      `SELECT pr.*, kt.remaining_balance 
       FROM payment_requests pr
       JOIN khata_transactions kt ON pr.transaction_id = kt.id
       WHERE pr.reference_id = ?`,
      [referenceId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment request not found.' });
    }

    const pr = rows[0];

    // Log the customer's payment reference in audit_logs so the shopkeeper can verify
    await query(
      `INSERT INTO audit_logs (shopkeeper_id, action, entity_type, entity_id, details)
       VALUES (?, 'CUSTOMER_PAYMENT_CONFIRMATION_SUBMITTED', 'payment_requests', ?, ?)`,
      [
        pr.shopkeeper_id,
        pr.id,
        JSON.stringify({
          referenceId,
          transactionId: pr.transaction_id,
          upiReference: upiReference || 'N/A',
          amount: pr.requested_amount,
          submittedAt: new Date().toISOString()
        })
      ]
    );

    return res.json({
      success: true,
      message: 'Payment notification recorded. The shopkeeper will verify and update your ledger balance.'
    });
  } catch (error) {
    console.error('Payment confirm error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Public JSON status checker
 */
router.get('/:referenceId/status', async (req, res) => {
  try {
    const { referenceId } = req.params;
    const rows = await query(
      `SELECT pr.status, pr.requested_amount, kt.remaining_balance, kt.status as transaction_status
       FROM payment_requests pr
       JOIN khata_transactions kt ON pr.transaction_id = kt.id
       WHERE pr.reference_id = ?`,
      [referenceId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    const pr = rows[0];
    return res.json({
      success: true,
      status: pr.status,
      isFullyPaid: pr.transaction_status === 'PAID' || Number(pr.remaining_balance) <= 0,
      remainingBalance: Number(pr.remaining_balance)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
