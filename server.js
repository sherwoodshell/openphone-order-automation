// OpenPhone Order Automation Workflow
// This script handles automated order intake from OpenPhone messages

const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const { google } = require('googleapis');

// Configuration
const CONFIG = {
  OPENPHONE_API_KEY: process.env.OPENPHONE_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GOOGLE_SHEETS_CREDENTIALS: process.env.GOOGLE_SHEETS_CREDENTIALS,
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
  TIMEZONE: 'America/New_York'
};

let lastProcessedTime = new Date();

class OrderAutomationService {
  constructor() {
    this.processedMessageIds = new Set();
    this.initializeGoogleSheets();
  }

  async initializeGoogleSheets() {
    try {
      if (!CONFIG.GOOGLE_SHEETS_CREDENTIALS) {
        console.log('Google Sheets credentials not provided');
        return;
      }
      const credentials = JSON.parse(CONFIG.GOOGLE_SHEETS_CREDENTIALS);
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      this.sheets = google.sheets({ version: 'v4', auth });
      console.log('Google Sheets initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Google Sheets:', error);
    }
  }

  // Fetch messages from OpenPhone API
  async fetchOpenPhoneMessages() {
    try {
      if (!CONFIG.OPENPHONE_API_KEY) {
        console.log('OpenPhone API key not provided');
        return [];
      }
      
      // First, let's just get all recent messages without specific filtering
      const response = await axios.get('https://api.openphone.com/v1/messages', {
        headers: {
          'Authorization': CONFIG.OPENPHONE_API_KEY,
          'Content-Type': 'application/json'
        },
        params: {
          limit: 50,
          createdAfter: lastProcessedTime.toISOString()
        }
      });

      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching OpenPhone messages:', error.response?.data || error.message);
      return [];
    }
  }

  // Analyze message with GPT for order detection
  async analyzeMessageForOrder(message) {
    const prompt = `
Analyze the following message to determine if it contains an order. Look for:
- Product names or descriptions
- Quantities
- Customer information (name, contact)
- Delivery/pickup preferences
- Payment information
- Any clear intent to purchase

Message: "${message.body}"
From: ${message.from}
Time: ${message.createdAt}

If this is an order, respond with JSON in this exact format:
{
  "isOrder": true,
  "customerName": "extracted name or 'Unknown'",
  "customerPhone": "phone number",
  "products": ["product1", "product2"],
  "quantities": ["qty1", "qty2"],
  "totalAmount": "amount if mentioned or 'TBD'",
  "specialRequests": "any special instructions",
  "urgency": "normal/urgent/asap",
  "extractedText": "key order details"
}

If not an order, respond with: {"isOrder": false}
`;

    try {
      if (!CONFIG.OPENAI_API_KEY) {
        console.log('OpenAI API key not provided');
        return { isOrder: false };
      }

      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are an expert at identifying and extracting order information from text messages. Always respond with valid JSON.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 500
      }, {
        headers: {
          'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      const analysis = JSON.parse(response.data.choices[0].message.content);
      return analysis;
    } catch (error) {
      console.error('Error analyzing message with GPT:', error);
      return { isOrder: false };
    }
  }

  // Log order to Google Sheets
  async logOrderToSheet(orderData, originalMessage) {
    try {
      if (!this.sheets || !CONFIG.GOOGLE_SHEET_ID) {
        console.log('Google Sheets not configured');
        return false;
      }

      const timestamp = new Date().toLocaleString('en-US', { 
        timeZone: CONFIG.TIMEZONE 
      });
      
      const row = [
        timestamp,
        orderData.customerName,
        orderData.customerPhone,
        orderData.products.join(', '),
        orderData.quantities.join(', '),
        orderData.totalAmount,
        orderData.specialRequests,
        orderData.urgency,
        originalMessage.body,
        originalMessage.id,
        'Pending' // Status
      ];

      await this.sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
        range: 'Orders!A:K',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [row]
        }
      });

      console.log('Order logged to Google Sheets successfully');
      return true;
    } catch (error) {
      console.error('Error logging to Google Sheets:', error);
      return false;
    }
  }

  // Send order notification to Slack via webhook
  async sendSlackNotification(orderData, originalMessage) {
    try {
      if (!CONFIG.SLACK_WEBHOOK_URL) {
        console.log('Slack webhook URL not provided');
        return false;
      }

      const urgencyEmoji = {
        'urgent': '🚨',
        'asap': '⚡',
        'normal': '📋'
      };

      const emoji = urgencyEmoji[orderData.urgency] || '📋';
      const timestamp = new Date(originalMessage.createdAt).toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE });
      
      const message = {
        text: `${emoji} *NEW ORDER RECEIVED*`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: `${emoji} New Order - Sherwood Island Oysters`
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Customer:*\n${orderData.customerName}`
              },
              {
                type: 'mrkdwn',
                text: `*Phone:*\n${orderData.customerPhone}`
              },
              {
                type: 'mrkdwn',
                text: `*Products:*\n${orderData.products.join(', ')}`
              },
              {
                type: 'mrkdwn',
                text: `*Quantities:*\n${orderData.quantities.join(', ')}`
              },
              {
                type: 'mrkdwn',
                text: `*Total Amount:*\n${orderData.totalAmount}`
              },
              {
                type: 'mrkdwn',
                text: `*Urgency:*\n${orderData.urgency.toUpperCase()}`
              }
            ]
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Special Requests:*\n${orderData.specialRequests || 'None'}`
            }
          },
          {
            type: 'divider'
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Original Message:*\n"${originalMessage.body}"`
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `📅 Received: ${timestamp} | 🆔 Message ID: ${originalMessage.id}`
              }
            ]
          }
        ]
      };

      await axios.post(CONFIG.SLACK_WEBHOOK_URL, message, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      console.log('Order notification sent to Slack successfully');
      return true;
    } catch (error) {
      console.error('Error sending Slack notification:', error);
      return false;
    }
  }

  // Main processing function
  async processMessages() {
    console.log(`Starting message processing at ${new Date().toLocaleString()}`);
    
    try {
      const messages = await this.fetchOpenPhoneMessages();
      console.log(`Found ${messages.length} new messages`);

      for (const message of messages) {
        // Skip if already processed
        if (this.processedMessageIds.has(message.id)) {
          continue;
        }

        // Only process inbound messages
        if (message.direction !== 'inbound') {
          this.processedMessageIds.add(message.id);
          continue;
        }

        console.log(`Processing message ${message.id} from ${message.from}`);

        // Analyze message for order
        const analysis = await this.analyzeMessageForOrder(message);
        
        if (analysis.isOrder) {
          console.log(`Order detected in message ${message.id}`);
          
          // Log to Google Sheets
          const sheetSuccess = await this.logOrderToSheet(analysis, message);
          
          // Send Slack notification
          const slackSuccess = await this.sendSlackNotification(analysis, message);
          
          if (sheetSuccess && slackSuccess) {
            console.log(`Order processed successfully: ${message.id}`);
          } else {
            console.log(`Order processed with some issues: ${message.id}`);
          }
        } else {
          console.log(`No order detected in message ${message.id}`);
        }

        // Mark as processed
        this.processedMessageIds.add(message.id);
      }

      // Update last processed time
      lastProcessedTime = new Date();
      console.log(`Message processing completed at ${new Date().toLocaleString()}`);
      
    } catch (error) {
      console.error('Error in message processing:', error);
    }
  }

  // Setup Google Sheets headers (run once)
  async setupGoogleSheetHeaders() {
    try {
      if (!this.sheets || !CONFIG.GOOGLE_SHEET_ID) {
        throw new Error('Google Sheets not configured');
      }

      const headers = [
        'Timestamp',
        'Customer Name',
        'Customer Phone',
        'Products',
        'Quantities',
        'Total Amount',
        'Special Requests',
        'Urgency',
        'Original Message',
        'Message ID',
        'Status'
      ];

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: CONFIG.GOOGLE_SHEET_ID,
        range: 'Orders!A1:K1',
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [headers]
        }
      });

      console.log('Google Sheets headers setup completed');
      return true;
    } catch (error) {
      console.error('Error setting up Google Sheets headers:', error);
      throw error;
    }
  }
}

// Initialize the service
const orderService = new OrderAutomationService();

// Schedule the cron job to run every 90 minutes between 5AM and 4PM EST
// Cron pattern: every 90 minutes from 5AM to 4PM (EST)
cron.schedule('0 5,6,8,9,11,12,14,15 * * *', () => {
  orderService.processMessages();
}, {
  timezone: CONFIG.TIMEZONE
});

// Also run every 90 minutes on the half hours that fit the schedule
cron.schedule('30 6,8,10,12,14 * * *', () => {
  orderService.processMessages();
}, {
  timezone: CONFIG.TIMEZONE
});

// Express server for health checks and manual triggers
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.get('/setup-sheets', async (req, res) => {
  try {
    await orderService.setupGoogleSheetHeaders();
    res.json({ success: true, message: 'Google Sheets setup completed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/setup-sheets', async (req, res) => {
  try {
    await orderService.setupGoogleSheetHeaders();
    res.json({ success: true, message: 'Google Sheets setup completed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/process-now', async (req, res) => {
  try {
    await orderService.processMessages();
    res.json({ success: true, message: 'Processing completed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/process-now', async (req, res) => {
  try {
    await orderService.processMessages();
    res.json({ success: true, message: 'Processing completed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Order automation service running on port ${PORT}`);
  console.log('Scheduled to run every 90 minutes between 5AM-4PM EST');
});

module.exports = { OrderAutomationService };
