
const cron = require('node-cron');
const { query } = require('../db/connection');
const { sendTransactionReminder } = require('./notificationService');
const { computeTransactionStatus } = require('./transactionService');

const TIME_ZONE = 'Asia/Kolkata';

// Get today's date in India as YYYY-MM-DD.
function getIndiaDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

// Convert a date to a stable UTC day number, avoiding DST/time differences.
function dayNumber(dateString) {
  const normalized = String(dateString).slice(0, 10);
  const [year, month, day] = normalized.split('-').map(Number);

  if (!year || !month || !day) {
    throw new Error(`Invalid date: ${dateString}`);
  }

  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

// Check whether a successful notification of this type already exists.
async function wasAlreadySent(transactionId, reminderType) {
  const rows = await query(
    `SELECT id
     FROM notification_logs
     WHERE transaction_id = ?
       AND reminder_type = ?
       AND status = 'SENT'
     LIMIT 1`,
    [transactionId, reminderType]
  );

  return rows.length > 0;
}

/**
 * Send scheduled reminders:
 * BEFORE_DUE: exactly one day before the due date.
 * ON_DUE: on the due date.
 * OVERDUE: exactly one day after the due date, if still unpaid.
 *
 * KHATA_CREATED is sent from the khata-creation flow, immediately
 * after a transaction is successfully created.
 */
async function runReminderJob() {
  const today = getIndiaDateString();

  console.log(`[Scheduler] Starting reminder scan for ${today}`);

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  try {
    const transactions = await query(`
      SELECT
        kt.*,
        s.shop_name,
        s.owner_name,
        s.upi_id,
        s.language_preference,
        s.auto_reminders_enabled
      FROM khata_transactions kt
      JOIN shopkeepers s ON kt.shopkeeper_id = s.id
      WHERE kt.remaining_balance > 0
        AND kt.status <> 'PAID'
        AND s.auto_reminders_enabled = TRUE
    `);

    for (const tx of transactions) {
      try {
        if (!tx.due_date) {
          console.warn(
            `[Scheduler] Skipping transaction ${tx.id}: no due date`
          );
          skippedCount++;
          continue;
        }

        const dueDate = String(tx.due_date).slice(0, 10);
        const diffDays = dayNumber(dueDate) - dayNumber(today);

        // Refresh the transaction status using your existing service.
        const currentStatus = computeTransactionStatus(
          tx.remaining_balance,
          dueDate
        );

        if (currentStatus !== tx.status) {
          await query(
            'UPDATE khata_transactions SET status = ? WHERE id = ?',
            [currentStatus, tx.id]
          );
          tx.status = currentStatus;
        }

        // Select only the three scheduled reminder dates.
        let reminderType = null;

        if (diffDays === 1) {
          reminderType = 'BEFORE_DUE';
        } else if (diffDays === 0) {
          reminderType = 'ON_DUE';
        } else if (diffDays === -1) {
          reminderType = 'OVERDUE';
        }

        if (!reminderType) {
          skippedCount++;
          continue;
        }

        // Do not send the same successful reminder twice.
        if (await wasAlreadySent(tx.id, reminderType)) {
          console.log(
            `[Scheduler] Already sent ${reminderType} for transaction ${tx.id}`
          );
          skippedCount++;
          continue;
        }

        // sendTransactionReminder rechecks the latest balance before sending.
        const shopkeeper = {
          id: tx.shopkeeper_id,
          shop_name: tx.shop_name,
          owner_name: tx.owner_name,
          upi_id: tx.upi_id,
          language_preference: tx.language_preference
        };

        const result = await sendTransactionReminder({
          transactionId: tx.id,
          shopkeeper,
          reminderType
        });

        if (result && result.success === true && result.status === 'SENT') {
          sentCount++;
          console.log(
            `[Scheduler] Sent ${reminderType} for transaction ${tx.id}`
          );
        } else {
          failedCount++;
          console.warn(
            `[Scheduler] Delivery not confirmed for transaction ${tx.id}:`,
            result?.status || 'UNKNOWN',
            result?.error || ''
          );
        }
      } catch (error) {
        failedCount++;
        console.error(
          `[Scheduler] Error for transaction ${tx.id}:`,
          error.message
        );
      }
    }

    console.log(
      `[Scheduler] Finished. Sent: ${sentCount}, ` +
      `Skipped: ${skippedCount}, Failed: ${failedCount}`
    );

    return {
      sentCount,
      skippedCount,
      failedCount,
      totalProcessed: transactions.length
    };
  } catch (error) {
    console.error('[Scheduler] Reminder scan failed:', error);
    throw error;
  }
}

function initScheduler() {
  if (process.env.ENABLE_CRON_REMINDERS !== 'true') {
    console.log(
      '[Scheduler] Disabled. Set ENABLE_CRON_REMINDERS=true in backend/.env'
    );
    return;
  }

  // Run every day at 9:00 AM Indian time.
  cron.schedule(
    '0 9 * * *',
    () => {
      runReminderJob().catch(error => {
        console.error('[Scheduler] Scheduled run failed:', error);
      });
    },
    { timezone: TIME_ZONE }
  );

  console.log(
    '[Scheduler] Daily reminders scheduled for 9:00 AM Asia/Kolkata.'
  );
}

module.exports = {
  initScheduler,
  runReminderJob
};
