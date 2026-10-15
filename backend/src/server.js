require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { initializeDatabase } = require('./db/init');
const { initScheduler, runReminderJob } = require('./services/scheduler');
const { requireAuth } = require('./middleware/auth');

// Routes
const authRoutes = require('./routes/authRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const customerRoutes = require('./routes/customerRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const reportRoutes = require('./routes/reportRoutes');
const publicPaymentRoutes = require('./routes/publicPaymentRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/reports', reportRoutes);

// Public Customer Payment Landing Page (No Auth Required)
app.use('/pay', publicPaymentRoutes);

// Scheduler Manual Trigger (Secured)
app.post('/api/reminders/run-scheduler', requireAuth, async (req, res) => {
  try {
    const result = await runReminderJob();
    res.json({
      success: true,
      message: 'Automated payment reminder job completed successfully.',
      result
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ONLINE',
    app: 'Khata Plus API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    database: 'MySQL 8.0 connected'
  });
});

// Serve compiled React Native Web App
const path = require('path');
const fs = require('fs');
const frontendDist = path.join(__dirname, '../../frontend/dist');

if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/pay')) {
      return next();
    }
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]:', err);
  res.status(500).json({
    success: false,
    message: err.message || 'Internal server error occurred.'
  });
});

// Boot Server
async function startServer() {
  try {
    // Ensure DB tables exist
    await initializeDatabase();

    // Start background reminder scheduler
    initScheduler();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`=======================================================`);
      console.log(`  KHATA PLUS BACKEND RUNNING ON http://localhost:${PORT}`);
      console.log(`  MySQL Database: khataplus_db connected.`);
      console.log(`  Customer Payment Portal: http://localhost:${PORT}/pay/:ref`);
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Failed to start Khata Plus server:', err);
    process.exit(1);
  }
}

startServer();

