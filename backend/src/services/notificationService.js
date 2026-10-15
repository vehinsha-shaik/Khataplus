const axios = require('axios');
const { query } = require('../db/connection');
const { generateOrUpdatePaymentRequest } = require('./paymentService');

/**
 * Message template dictionary for English and Telugu
 */
const TEMPLATES = {
  en: {
    BEFORE_DUE: ({ customerName, shopName, description, balance, dueDate, payUrl }) =>
      `Hello ${customerName}, this is a friendly reminder from ${shopName}. Your outstanding balance for ${description} is ₹${balance}, due on ${dueDate}. You can pay using PhonePe/UPI here: ${payUrl} or visit our shop. Thank you!`,
    ON_DUE: ({ customerName, shopName, balance, dueDate, payUrl }) =>
      `Hello ${customerName}, your payment of ₹${balance} to ${shopName} is due today (${dueDate}). Please complete the payment using PhonePe/UPI: ${payUrl} or pay at the shop. Thank you!`,
    OVERDUE: ({ customerName, shopName, balance, dueDate, daysOverdue, payUrl }) =>
      `Hello ${customerName}, your payment of ₹${balance} to ${shopName} was due on ${dueDate} and is now overdue by ${daysOverdue} day(s). Please settle the outstanding amount as soon as possible via PhonePe/UPI: ${payUrl}. If already paid, please contact the shop. Thank you!`,
    MANUAL: ({ customerName, shopName, balance, dueDate, payUrl }) =>
      `Hello ${customerName}, friendly payment reminder from ${shopName} for your outstanding balance of ₹${balance} (Due: ${dueDate}). Pay securely with PhonePe/UPI: ${payUrl}. Thank you!`
  },
  te: {
    BEFORE_DUE: ({ customerName, shopName, description, balance, dueDate, payUrl }) =>
      `నమస్కారం ${customerName}, ${shopName} నుండి సమాచారం. మీ కొనుగోలు (${description}) బకాయి మొత్తం ₹${balance}, గడువు తేదీ ${dueDate}. క్రింది PhonePe/UPI లింక్ ద్వారా చెల్లించండి: ${payUrl} లేదా దుకాణానికి రండి. ధన్యవాదాలు!`,
    ON_DUE: ({ customerName, shopName, balance, dueDate, payUrl }) =>
      `నమస్కారం ${customerName}, ${shopName} కు చెల్లించాల్సిన ₹${balance} బకాయి ఈరోజే (${dueDate}) గడువు. క్రింది PhonePe/UPI లింక్ ద్వారా చెల్లించండి: ${payUrl} లేదా దుకాణంలో ఇవ్వండి. ధన్యవాదాలు!`,
    OVERDUE: ({ customerName, shopName, balance, dueDate, daysOverdue, payUrl }) =>
      `నమస్కారం ${customerName}, ${shopName} కు చెల్లించాల్సిన ₹${balance} బకాయి గడువు (${dueDate}) ముగిసి ${daysOverdue} రోజులు అయ్యింది. దయచేసి వెంటనే PhonePe/UPI ద్వారా చెల్లించండి: ${payUrl}. ఇప్పటికే చెల్లించినచో దుకాణాన్ని సంప్రదించండి. ధన్యవాదాలు!`,
    MANUAL: ({ customerName, shopName, balance, dueDate, payUrl }) =>
      `నమస్కారం ${customerName}, ${shopName} నుండి బకాయి గుర్తుచేంపు. మొత్తం ₹${balance} (గడువు: ${dueDate}). PhonePe/UPI ద్వారా చెల్లించండి: ${payUrl}. ధన్యవాదాలు!`
  }
};

/**
 * Format message based on language and reminder type
 */
function buildMessage({ language = 'en', reminderType, customerName, shopName, description, balance, dueDate, daysOverdue = 0, payUrl }) {
  const langKey = language === 'te' ? 'te' : 'en';
  const tmpl = TEMPLATES[langKey][reminderType] || TEMPLATES[langKey].MANUAL;
  return tmpl({
    customerName,
    shopName,
    description: description || 'Groceries / Items',
    balance: Number(balance).toFixed(2),
    dueDate,
    daysOverdue,
    payUrl: payUrl || ''
  });
}

/**
 * Normalize Indian phone number to format with country code: +919876543210
 */
function normalizePhoneNumber(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+')) {
    if (cleaned.length === 10) {
      cleaned = '+91' + cleaned;
    } else if (cleaned.length === 12 && cleaned.startsWith('91')) {
      cleaned = '+' + cleaned;
    }
  }
  return cleaned;
}

/**
 * Real WhatsApp Cloud API Sender
 */
async function sendWhatsAppViaCloudApi(recipientPhone, messageText) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    return {
      success: false,
      status: 'CONFIGURATION_MISSING',
      provider: 'WHATSAPP_CLOUD',
      error: 'WhatsApp Cloud API credentials (WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID) not configured in .env'
    };
  }

  const cleanPhone = recipientPhone.replace(/\+/g, '');
  const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: { body: messageText }
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    const messageId = response.data?.messages?.[0]?.id || 'WAMI_SUCCESS';
    return {
      success: true,
      status: 'SENT',
      provider: 'WHATSAPP_CLOUD',
      messageId,
      raw: response.data
    };
  } catch (err) {
    return {
      success: false,
      status: 'FAILED',
      provider: 'WHATSAPP_CLOUD',
      error: err.response?.data || err.message
    };
  }
}

/**
 * Real SMS Sender (Fast2SMS / Twilio)
 */
async function sendSmsViaGateway(recipientPhone, messageText) {
  const cleanPhone = recipientPhone.replace(/[^\d]/g, '').slice(-10); // Indian 10 digits

  // 1. Try Fast2SMS if configured
  if (process.env.SMS_API_KEY) {
    try {
      const response = await axios.post(
        'https://www.fast2sms.com/dev/bulkV2',
        {
          route: process.env.FAST2SMS_ROUTE || 'q',
          message: messageText,
          language: 'english',
          flash: 0,
          numbers: cleanPhone
        },
        {
          headers: {
            authorization: process.env.SMS_API_KEY
          },
          timeout: 10000
        }
      );

      return {
        success: response.data?.return === true,
        status: response.data?.return === true ? 'SENT' : 'FAILED',
        provider: 'FAST2SMS',
        messageId: response.data?.request_id || null,
        raw: response.data
      };
    } catch (err) {
      return {
        success: false,
        status: 'FAILED',
        provider: 'FAST2SMS',
        error: err.response?.data || err.message
      };
    }
  }

  // 2. Try Twilio if configured
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_PHONE) {
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const from = process.env.TWILIO_FROM_PHONE;
      const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

      const params = new URLSearchParams();
      params.append('To', recipientPhone);
      params.append('From', from);
      params.append('Body', messageText);

      const response = await axios.post(twilioUrl, params.toString(), {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      });

      return {
        success: true,
        status: 'SENT',
        provider: 'TWILIO',
        messageId: response.data?.sid,
        raw: response.data
      };
    } catch (err) {
      return {
        success: false,
        status: 'FAILED',
        provider: 'TWILIO',
        error: err.response?.data || err.message
      };
    }
  }

  // Gateway credentials missing
  return {
    success: false,
    status: 'CONFIGURATION_MISSING',
    provider: 'SMS_GATEWAY',
    error: 'SMS provider credentials (SMS_API_KEY for Fast2SMS or TWILIO credentials) not configured in .env'
  };
}

/**
 * Send notification for a khata transaction
 */
async function sendTransactionReminder({
  transactionId,
  shopkeeper,
  reminderType = 'MANUAL',
  forceChannel = null,
  overrideLanguage = null
}) {
  // 1. Fetch transaction and customer data with fresh balance check
  const rows = await query(
    `SELECT kt.*, c.full_name as customer_name, c.phone_number as customer_phone, c.preferred_channel
     FROM khata_transactions kt
     JOIN customers c ON kt.customer_id = c.id
     WHERE kt.id = ? AND kt.shopkeeper_id = ?`,
    [transactionId, shopkeeper.id]
  );

  if (!rows || rows.length === 0) {
    throw new Error('Khata transaction not found.');
  }

  const tx = rows[0];

  // Section 9 Rule: Stop reminders immediately when transaction is fully paid
  if (Number(tx.remaining_balance) <= 0 || tx.status === 'PAID') {
    return {
      suppressed: true,
      message: 'Transaction is fully settled. Reminders are automatically suppressed.'
    };
  }

  // 2. Refresh / generate payment request to get latest remaining balance & PhonePe link
  const payReq = await generateOrUpdatePaymentRequest(transactionId, shopkeeper);
  const payUrl = payReq ? payReq.publicPayUrl : '';

  // 3. Determine language
  const language = overrideLanguage || shopkeeper.language_preference || 'en';

  // 4. Calculate days overdue if applicable
  const today = new Date().toISOString().split('T')[0];
  let daysOverdue = 0;
  if (tx.due_date < today) {
    const diffTime = Math.abs(new Date(today) - new Date(tx.due_date));
    daysOverdue = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  // 5. Build message text
  const messageText = buildMessage({
    language,
    reminderType,
    customerName: tx.customer_name,
    shopName: shopkeeper.shop_name,
    description: tx.purchase_description,
    balance: tx.remaining_balance,
    dueDate: tx.due_date,
    daysOverdue,
    payUrl
  });

  // 6. Channel Selection (Section 10 Requirement)
  let channel = forceChannel;
  if (!channel) {
    if (tx.preferred_channel === 'WHATSAPP') {
      channel = 'WHATSAPP';
    } else if (tx.preferred_channel === 'SMS') {
      channel = 'SMS';
    } else {
      // AUTO selection: prefer WhatsApp if configured or default to WhatsApp
      channel = 'WHATSAPP';
    }
  }

  const normalizedPhone = normalizePhoneNumber(tx.customer_phone);

  // Generate Direct WhatsApp Web/App click-to-chat URL (instant deep link for shopkeeper or device)
  const waDirectUrl = `https://wa.me/${normalizedPhone.replace(/\+/g, '')}?text=${encodeURIComponent(messageText)}`;
  const smsDirectUrl = `sms:${normalizedPhone}?body=${encodeURIComponent(messageText)}`;

  // 7. Dispatch via configured provider
  let sendResult;
  if (channel === 'WHATSAPP') {
    sendResult = await sendWhatsAppViaCloudApi(normalizedPhone, messageText);
  } else {
    sendResult = await sendSmsViaGateway(normalizedPhone, messageText);
  }

  // 8. Log reminder in notification_logs table (Section 9 Requirement)
  const logInsert = await query(
    `INSERT INTO notification_logs 
     (transaction_id, customer_id, shopkeeper_id, channel, reminder_type, language, recipient_phone, message_text, payment_link, status, provider, provider_message_id, provider_response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tx.id,
      tx.customer_id,
      shopkeeper.id,
      channel,
      reminderType,
      language,
      normalizedPhone,
      messageText,
      payUrl,
      sendResult.status,
      sendResult.provider,
      sendResult.messageId || null,
      JSON.stringify(sendResult.raw || { error: sendResult.error || 'N/A' })
    ]
  );

  return {
    success: sendResult.success,
    status: sendResult.status,
    channel,
    language,
    messageText,
    paymentLink: payUrl,
    directWhatsAppUrl: waDirectUrl,
    directSmsUrl: smsDirectUrl,
    notificationLogId: logInsert.insertId,
    provider: sendResult.provider,
    error: sendResult.error || null,
    explanation:
      sendResult.status === 'CONFIGURATION_MISSING'
        ? `Provider credentials not configured in backend .env. Direct deep links (${channel}) generated for one-tap delivery.`
        : 'Dispatched through configured gateway.'
  };
}

module.exports = {
  TEMPLATES,
  buildMessage,
  normalizePhoneNumber,
  sendTransactionReminder
};
