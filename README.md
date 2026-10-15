# Khata Plus — Smart Digital Credit Ledger & Payment Reminder Application

**Khata Plus** is a modern, production-oriented mobile application for Indian shopkeepers to manage customer credit (udhaar/khata), track outstanding balances, enforce payment deadlines, and automatically send payment reminders via WhatsApp or SMS.

> **Key Design Principle**: Customers do **NOT** need to download or register for any application. They receive payment reminders via WhatsApp or normal SMS with verified PhonePe UPI payment links and dynamic QR codes.

---

## 1. Technology Architecture

- **Mobile App**: React Native + Expo (JavaScript).
- **Backend**: Node.js + Express.js REST APIs.
- **Database**: **MySQL 8.0 Only** using `mysql2/promise` with connection pooling, exact decimal financial precision (`DECIMAL(12, 2)`), ACID database transactions with row-level locking (`FOR UPDATE`), foreign keys, and indexes.
- **Payment Destination**: **PhonePe** as the primary intended UPI destination, with deep links (`phonepe://pay?...`), generic UPI intent fallback (`upi://pay?...`), and dynamic Base64 QR code generation (`qrcode`).
- **Reminders**: Automated scheduled reminders using `node-cron` with multi-language templates (**English & Telugu**), channel selection (WhatsApp / SMS / Auto), and delivery audit logs.
- **Customer Payment Portal**: Web payment landing page (`/pay/:referenceId`) with PhonePe payment button, QR code, and UPI reference submission.

---

## 2. MySQL Database Schema

All database tables are initialized and verified in MySQL `khataplus_db`:

1. **`shopkeepers`**: Store owner accounts, shop name, phone number, password hash (bcrypt), verified shopkeeper UPI ID, language preference (`en` / `te`), and reminder schedule.
2. **`customers`**: Customer profiles scoped to the shopkeeper with duplicate phone prevention (`UNIQUE(shopkeeper_id, phone_number)`), preferred channel (`WHATSAPP`, `SMS`, `AUTO`), address, and notes.
3. **`khata_transactions`**: Credit transactions maintaining `original_amount`, `total_paid`, `remaining_balance`, `due_date`, and status (`UPCOMING`, `OVERDUE`, `PAID`).
4. **`payment_entries`**: Immutable ledger of every partial and full payment received with payment method (`CASH`, `PHONEPE`, `UPI`, `BANK_TRANSFER`), timestamp, and reference ID.
5. **`transaction_adjustments`**: Complete audit trail of due date extensions and amount corrections with reason and old/new values.
6. **`payment_requests`**: Dynamic PhonePe and UPI payment intents with reference IDs and Base64 QR code images.
7. **`notification_logs`**: Delivery logs for WhatsApp and SMS messages including channel, template, recipient, provider, delivery status, and payload.
8. **`audit_logs`**: Comprehensive security and financial operation logs.

---

## 3. Demo Credentials & Quick Test

The database includes a pre-seeded shopkeeper account:

- **Mobile Number**: `9876543210`
- **Password**: `password123`
- **Shop Name**: Sri Lakshmi Kirana & General Store
- **Verified Payee UPI**: `srilakshmi.store@ybl`
- **Default Language**: English / Telugu toggle available

---

## 4. Key Application Features

### A. Main Dashboard
- **6 Summary Cards**:
  1. Total Outstanding Credit (₹)
  2. Total Amount Collected (₹)
  3. Upcoming Payments (Count & Amount)
  4. Payments Due Today (Count & Amount)
  5. Overdue Payments (Count & Amount in red alert)
  6. Fully Paid Transactions (Count & Amount in green)
- **Quick Action Bar**:
  - Add Customer
  - Add Khata / Credit Bill
  - View Upcoming
  - View Overdue
  - View Paid
  - All Customers
- **Recent Ledger Activity** & **Urgent Deadlines (Next 7 Days)**.

### B. Three Main Payment Categories
- **Upcoming Payments**: Transactions due in the future with outstanding balance > 0, showing countdown badges ("X days left"), search bar, and action menu.
- **Overdue Payments**: Transactions whose due dates have passed with outstanding balance > 0, showing alert red badges ("X days overdue"), search bar, and action menu.
- **Paid Payments**: Fully settled bills (remaining balance = 0), showing settlement date, payment method, and search bar.
- *Note*: Transactions with partial payments remain in Upcoming or Overdue until their balance reaches zero.

### C. Three Mandatory Actions on Every Transaction
1. **Mark as Paid**: Full settlement confirmation dialog, records payment entry, updates remaining balance to 0, moves to Paid section, and suppresses future reminders.
2. **Change Due Date**: Date selector with quick presets (+3, +7, +15, +30 days), captures reason for extension, records audit history, recalculates category, and reschedules reminders.
3. **Record Partial Payment**: Accepts partial amount received, recalculates remaining balance (`Original - Total Paid`), preserves transaction history, and regenerates PhonePe QR code for the new balance.

### D. PhonePe / UPI Payment Experience
- Customer reminder contains a secure link: `http://<HOST>:5000/pay/:referenceId`
- On tapping the link, the customer lands on a mobile-responsive web payment page.
- Direct **"Pay with PhonePe"** button attempts `phonepe://pay?...` intent.
- Fallback **"Pay with Any UPI App"** button (`upi://pay?...`).
- Dynamic **QR Code** displayed for scanning with another phone.
- Customer can submit UPI reference/UTR for shopkeeper verification.

### E. WhatsApp & SMS Automated Notifications
- **Telugu and English** message templates for:
  - Gentle Reminder (before deadline)
  - Payment Due Reminder (on deadline)
  - Overdue Alert (after deadline with overdue days)
- Automatic channel selection (WhatsApp / SMS / Auto).
- One-tap direct WhatsApp Web/App launcher (`wa.me/...`) and SMS intent launcher.
- Daily scheduled cron job at 09:00 AM IST (`src/services/scheduler.js`).
- Manual trigger API: `POST /api/reminders/run-scheduler`.

---

## 5. How to Run

### Backend API & Web Application
```powershell
cd c:\Khataplus\backend
npm install
node src/server.js
```
The backend starts at `http://localhost:5000` and automatically connects to MySQL `khataplus_db`.
It also serves the compiled React Native Web App at `http://localhost:5000`.

### Mobile Frontend (Expo)
```powershell
cd c:\Khataplus\frontend
npm install
npm start
```
- Press `a` to open on an Android emulator or scan the QR code with **Expo Go** on a physical Android phone.
- Press `w` to open in a web browser.

### Building Android APK
The project includes a fully generated Android native project (`frontend/android`) and `eas.json` build profile:
```powershell
cd c:\Khataplus\frontend
npx eas-cli build -p android --profile preview
```
This produces a standalone installable `.apk` file for Android devices.

