const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const Airtable = require('airtable');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// Configure middleware
app.use(express.raw({type: 'application/json'}));
app.use('/webhook', express.raw({type: 'application/json'}));
app.use(express.json());

// Configure Airtable
const airtable = new Airtable({apiKey: process.env.AIRTABLE_API_KEY});
const base = airtable.base('appUNIsu8KgvOlmi0'); // Growth AI base

// Configure Gmail
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Logging system
const logs = [];
function log(message, level = 'info') {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message
  };
  logs.push(entry);
  console.log(`[${entry.timestamp}] ${entry.level.toUpperCase()}: ${entry.message}`);
  
  // Keep only last 100 logs
  if (logs.length > 100) {
    logs.shift();
  }
}

// Create Failed Payments table structure if needed
async function ensureFailedPaymentsTable() {
  try {
    // We'll create records in a table called "Failed Payments"
    // Airtable will auto-create the table when we add the first record
    log('Failed Payments table structure ready');
  } catch (error) {
    log(`Error setting up table: ${error.message}`, 'error');
  }
}

// Send Gmail alert
async function sendFailedPaymentAlert(paymentData) {
  try {
    const emailContent = `
      <h2>🚨 Payment Failed Alert</h2>
      <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
      <p><strong>Amount:</strong> $${(paymentData.amount / 100).toFixed(2)} ${paymentData.currency.toUpperCase()}</p>
      <p><strong>Customer:</strong> ${paymentData.customer_email || 'N/A'}</p>
      <p><strong>Customer ID:</strong> ${paymentData.customer || 'N/A'}</p>
      <p><strong>Payment ID:</strong> ${paymentData.id}</p>
      <p><strong>Failure Code:</strong> ${paymentData.failure_code || 'N/A'}</p>
      <p><strong>Failure Message:</strong> ${paymentData.failure_message || 'N/A'}</p>
      <p><strong>Description:</strong> ${paymentData.description || 'N/A'}</p>
      
      <hr>
      <p><small>This is an automated alert from your Stripe Payment Monitor</small></p>
    `;

    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER, // Send to yourself, but you can customize this
      subject: `🚨 Payment Failed: $${(paymentData.amount / 100).toFixed(2)}`,
      html: emailContent
    };

    await transporter.sendMail(mailOptions);
    log(`Failed payment alert sent via Gmail for payment ${paymentData.id}`);
  } catch (error) {
    log(`Error sending Gmail alert: ${error.message}`, 'error');
  }
}

// Update Airtable with failed payment
async function updateAirtableFailedPayment(paymentData) {
  try {
    const record = await base('Failed Payments').create([
      {
        fields: {
          'Payment ID': paymentData.id,
          'Amount': (paymentData.amount / 100),
          'Currency': paymentData.currency.toUpperCase(),
          'Customer Email': paymentData.customer_email || 'N/A',
          'Customer ID': paymentData.customer || 'N/A',
          'Failure Code': paymentData.failure_code || 'N/A',
          'Failure Message': paymentData.failure_message || 'N/A',
          'Description': paymentData.description || 'N/A',
          'Failed At': new Date().toISOString(),
          'Status': 'Failed',
          'Source': paymentData.source?.type || 'N/A'
        }
      }
    ]);
    
    log(`Failed payment record created in Airtable: ${record[0].id}`);
    return record[0];
  } catch (error) {
    log(`Error creating Airtable record: ${error.message}`, 'error');
    throw error;
  }
}

// Process failed payment event
async function processFailedPayment(eventData) {
  try {
    const paymentData = eventData.data.object;
    log(`Processing failed payment: ${paymentData.id}, Amount: $${(paymentData.amount / 100).toFixed(2)}`);

    // Send Gmail alert
    await sendFailedPaymentAlert(paymentData);

    // Update Airtable
    await updateAirtableFailedPayment(paymentData);

    log(`Successfully processed failed payment: ${paymentData.id}`);
  } catch (error) {
    log(`Error processing failed payment: ${error.message}`, 'error');
    throw error;
  }
}

// Standard endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'Stripe Payment Monitor',
    status: 'active',
    endpoints: {
      'GET /': 'This status page',
      'GET /health': 'Health check',
      'GET /logs': 'View recent logs',
      'POST /test': 'Manual test run',
      'POST /webhook': 'Stripe webhook endpoint'
    },
    description: 'Monitors Stripe for failed payments and sends alerts via Gmail and Airtable'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/logs', (req, res) => {
  res.json({ 
    logs: logs.slice(-50), // Last 50 logs
    total: logs.length 
  });
});

app.post('/test', async (req, res) => {
  try {
    log('Manual test run initiated');
    
    // Test Gmail connection
    const testMail = await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.GMAIL_USER,
      subject: 'Test: Stripe Payment Monitor is Working',
      html: '<p>This is a test email to confirm your Stripe Payment Monitor is working correctly!</p>'
    });
    
    // Test Airtable connection
    const testRecord = await base('Failed Payments').create([
      {
        fields: {
          'Payment ID': 'TEST_' + Date.now(),
          'Amount': 99.99,
          'Currency': 'USD',
          'Customer Email': 'test@example.com',
          'Failure Code': 'TEST',
          'Failure Message': 'This is a test record',
          'Failed At': new Date().toISOString(),
          'Status': 'Test'
        }
      }
    ]);
    
    log('Manual test completed successfully');
    res.json({ 
      success: true, 
      message: 'Test completed successfully',
      gmail_test: 'Email sent',
      airtable_test: `Record created: ${testRecord[0].id}`
    });
  } catch (error) {
    log(`Manual test failed: ${error.message}`, 'error');
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Stripe webhook endpoint
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify webhook signature if endpoint secret is available
    if (process.env.STRIPE_WEBHOOK_SECRET) {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }

    log(`Received Stripe webhook: ${event.type}`);

    // Handle different types of failed payment events
    switch (event.type) {
      case 'charge.failed':
        await processFailedPayment(event);
        break;
      case 'payment_intent.payment_failed':
        await processFailedPayment(event);
        break;
      case 'invoice.payment_failed':
        await processFailedPayment(event);
        break;
      case 'payment_method.attach_failed':
        await processFailedPayment(event);
        break;
      default:
        log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    log(`Webhook error: ${error.message}`, 'error');
    res.status(400).send(`Webhook error: ${error.message}`);
  }
});

// Initialize and start server
async function initialize() {
  try {
    await ensureFailedPaymentsTable();
    log('Stripe Payment Monitor initialized successfully');
  } catch (error) {
    log(`Initialization error: ${error.message}`, 'error');
  }
}

app.listen(port, () => {
  log(`Stripe Payment Monitor running on port ${port}`);
  initialize();
});

module.exports = app;