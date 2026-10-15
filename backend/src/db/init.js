const { pool } = require('./connection');
const bcrypt = require('bcryptjs');

async function initializeDatabase() {
  console.log('Initializing Khata Plus MySQL database...');
  const conn = await pool.getConnection();

  try {
    // 1. Shopkeepers table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS shopkeepers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shop_name VARCHAR(150) NOT NULL,
        owner_name VARCHAR(100) NOT NULL,
        phone_number VARCHAR(20) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        upi_id VARCHAR(100) NOT NULL,
        language_preference VARCHAR(10) NOT NULL DEFAULT 'en',
        reminder_days_before INT NOT NULL DEFAULT 2,
        auto_reminders_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_phone (phone_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Customers table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shopkeeper_id INT NOT NULL,
        full_name VARCHAR(120) NOT NULL,
        phone_number VARCHAR(20) NOT NULL,
        preferred_channel ENUM('WHATSAPP', 'SMS', 'AUTO') NOT NULL DEFAULT 'AUTO',
        address TEXT NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_shop_customer_phone (shopkeeper_id, phone_number),
        FOREIGN KEY (shopkeeper_id) REFERENCES shopkeepers(id) ON DELETE CASCADE,
        INDEX idx_customer_search (shopkeeper_id, full_name, phone_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. Khata Transactions table
    await conn.query(`
      CREATE TABLE IF NOT EXISTS khata_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shopkeeper_id INT NOT NULL,
        customer_id INT NOT NULL,
        purchase_description TEXT NOT NULL,
        original_amount DECIMAL(12, 2) NOT NULL,
        total_paid DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
        remaining_balance DECIMAL(12, 2) NOT NULL,
        transaction_date DATE NOT NULL,
        due_date DATE NOT NULL,
        status ENUM('UPCOMING', 'OVERDUE', 'PAID') NOT NULL DEFAULT 'UPCOMING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (shopkeeper_id) REFERENCES shopkeepers(id) ON DELETE CASCADE,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        INDEX idx_shop_status (shopkeeper_id, status),
        INDEX idx_shop_due (shopkeeper_id, due_date),
        INDEX idx_customer_tx (shopkeeper_id, customer_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. Payment Entries table (Audit of each partial or full payment)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS payment_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        transaction_id INT NOT NULL,
        shopkeeper_id INT NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        payment_method ENUM('CASH', 'PHONEPE', 'UPI', 'BANK_TRANSFER', 'OTHER') NOT NULL DEFAULT 'CASH',
        payment_reference VARCHAR(150) NULL,
        notes TEXT NULL,
        payment_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (transaction_id) REFERENCES khata_transactions(id) ON DELETE CASCADE,
        FOREIGN KEY (shopkeeper_id) REFERENCES shopkeepers(id) ON DELETE CASCADE,
        INDEX idx_tx_payment (transaction_id),
        INDEX idx_shop_payment (shopkeeper_id, payment_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 5. Transaction Adjustments table (Audit of amount correction or deadline change)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS transaction_adjustments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        transaction_id INT NOT NULL,
        shopkeeper_id INT NOT NULL,
        adjustment_type ENUM('DUE_DATE_CHANGE', 'AMOUNT_CORRECTION', 'DETAILS_UPDATE') NOT NULL,
        previous_value TEXT NOT NULL,
        updated_value TEXT NOT NULL,
        reason TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (transaction_id) REFERENCES khata_transactions(id) ON DELETE CASCADE,
        FOREIGN KEY (shopkeeper_id) REFERENCES shopkeepers(id) ON DELETE CASCADE,
        INDEX idx_tx_adj (transaction_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 6. Payment Requests (Dynamic PhonePe & UPI links generated for customers)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS payment_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        transaction_id INT NOT NULL,
        shopkeeper_id INT NOT NULL,
        reference_id VARCHAR(100) NOT NULL UNIQUE,
        payee_upi_id VARCHAR(100) NOT NULL,
        payee_name VARCHAR(150) NOT NULL,
        requested_amount DECIMAL(12, 2) NOT NULL,
        upi_intent_url TEXT NOT NULL,
        phonepe_intent_url TEXT NOT NULL,
        qr_code_data_url LONGTEXT NULL,
        status ENUM('PENDING', 'PAID', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (transaction_id) REFERENCES khata_transactions(id) ON DELETE CASCADE,
        FOREIGN KEY (shopkeeper_id) REFERENCES shopkeepers(id) ON DELETE CASCADE,
        INDEX idx_ref (reference_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 7. Notification Logs (WhatsApp & SMS delivery auditing)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS notification_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        transaction_id INT NOT NULL,
        customer_id INT NOT NULL,
        shopkeeper_id INT NOT NULL,
        channel ENUM('WHATSAPP', 'SMS') NOT NULL,
        reminder_type ENUM('BEFORE_DUE', 'ON_DUE', 'OVERDUE', 'MANUAL') NOT NULL,
        language VARCHAR(10) NOT NULL DEFAULT 'en',
        recipient_phone VARCHAR(20) NOT NULL,
        message_text TEXT NOT NULL,
        payment_link TEXT NULL,
        status ENUM('SENT', 'DELIVERED', 'FAILED', 'CONFIGURATION_MISSING') NOT NULL,
        provider VARCHAR(50) NOT NULL,
        provider_message_id VARCHAR(150) NULL,
        provider_response TEXT NULL,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (transaction_id) REFERENCES khata_transactions(id) ON DELETE CASCADE,
        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE,
        FOREIGN KEY (shopkeeper_id) REFERENCES shopkeepers(id) ON DELETE CASCADE,
        INDEX idx_reminder_history (transaction_id, sent_at),
        INDEX idx_customer_notif (customer_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 8. Audit Logs
    await conn.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        shopkeeper_id INT NOT NULL,
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        entity_id INT NULL,
        details JSON NULL,
        ip_address VARCHAR(45) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_shop (shopkeeper_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Check if demo shopkeeper exists, else seed one
    const [existing] = await conn.query('SELECT id FROM shopkeepers WHERE phone_number = ?', ['9876543210']);
    if (existing.length === 0) {
      const defaultPasswordHash = await bcrypt.hash('password123', 10);
      const [insertShop] = await conn.query(
        `INSERT INTO shopkeepers (shop_name, owner_name, phone_number, password_hash, upi_id, language_preference, reminder_days_before)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['Sri Lakshmi Kirana & General Store', 'Ramesh Kumar', '9876543210', defaultPasswordHash, 'srilakshmi.store@ybl', 'en', 2]
      );
      const shopId = insertShop.insertId;

      // Seed sample customers
      const [cust1] = await conn.query(
        `INSERT INTO customers (shopkeeper_id, full_name, phone_number, preferred_channel, address, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [shopId, 'Suresh Reddy', '+919848012345', 'WHATSAPP', 'H.No 4-52, Market Road, Hyderabad', 'Regular customer, prefers WhatsApp reminders']
      );

      const [cust2] = await conn.query(
        `INSERT INTO customers (shopkeeper_id, full_name, phone_number, preferred_channel, address, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [shopId, 'Anil Sharma', '+919988776655', 'SMS', 'Opp. Gandhi Statue, Hyderabad', 'Uses basic phone, send SMS reminders']
      );

      const [cust3] = await conn.query(
        `INSERT INTO customers (shopkeeper_id, full_name, phone_number, preferred_channel, address, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [shopId, 'Venkatesh Rao', '+919123456789', 'AUTO', 'Plot 12, Sri Nagar Colony', 'Preferred language Telugu']
      );

      // Seed sample khata transactions
      // 1. Upcoming transaction
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 5);
      const futureDateStr = futureDate.toISOString().split('T')[0];

      await conn.query(
        `INSERT INTO khata_transactions (shopkeeper_id, customer_id, purchase_description, original_amount, total_paid, remaining_balance, transaction_date, due_date, status)
         VALUES (?, ?, ?, ?, ?, ?, CURDATE(), ?, 'UPCOMING')`,
        [shopId, cust1.insertId, '5kg Basmati Rice, 2L Fortune Sunflower Oil, Spices', 1500.00, 0.00, 1500.00, futureDateStr]
      );

      // 2. Overdue transaction
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 4);
      const pastDateStr = pastDate.toISOString().split('T')[0];

      await conn.query(
        `INSERT INTO khata_transactions (shopkeeper_id, customer_id, purchase_description, original_amount, total_paid, remaining_balance, transaction_date, due_date, status)
         VALUES (?, ?, ?, ?, ?, ?, DATE_SUB(CURDATE(), INTERVAL 10 DAY), ?, 'OVERDUE')`,
        [shopId, cust2.insertId, 'Monthly groceries, atta 10kg, dal 2kg, soap box', 2400.00, 400.00, 2000.00, pastDateStr]
      );

      // 3. Paid transaction
      const [paidTx] = await conn.query(
        `INSERT INTO khata_transactions (shopkeeper_id, customer_id, purchase_description, original_amount, total_paid, remaining_balance, transaction_date, due_date, status)
         VALUES (?, ?, ?, ?, ?, ?, DATE_SUB(CURDATE(), INTERVAL 15 DAY), DATE_SUB(CURDATE(), INTERVAL 2 DAY), 'PAID')`,
        [shopId, cust3.insertId, 'Dry fruits pack, cashew 500g, badam 500g', 1200.00, 1200.00, 0.00]
      );

      // Add payment entry for paid transaction
      await conn.query(
        `INSERT INTO payment_entries (transaction_id, shopkeeper_id, amount, payment_method, payment_reference, notes)
         VALUES (?, ?, ?, 'PHONEPE', 'UPI-PHNP-993821039', 'Paid via PhonePe QR code at shop')`,
        [paidTx.insertId, shopId, 1200.00]
      );

      console.log('Seed data successfully created for demo shopkeeper (Phone: 9876543210, Password: password123)');
    }

    console.log('All MySQL tables initialized and verified successfully!');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  } finally {
    conn.release();
  }
}

// Execute directly if run as a script
if (require.main === module) {
  initializeDatabase()
    .then(() => {
      console.log('Database initialization complete.');
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { initializeDatabase };

