import wppconnect from '@wppconnect-team/wppconnect';
import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3005;

// Memory stores
const waToTicketMap = new Map(); // Maps WA Number -> Zendesk Ticket ID
const ticketToWaMap = new Map(); // Maps Zendesk Ticket ID -> WA Number
const pausedNumbers = new Set(); // Numbers where AI is paused

let whatsappClient = null;

// ── Helpers for Zendesk ─────────────────────────────────────────────
function getZendeskHeaders() {
  const credentials = `${process.env.ZENDESK_EMAIL}/token:${process.env.ZENDESK_API_TOKEN}`;
  const encoded = Buffer.from(credentials).toString('base64');
  return {
    Authorization: `Basic ${encoded}`,
    'Content-Type': 'application/json',
  };
}

async function getOrCreateTicket(waNumber, firstMessage) {
  if (waToTicketMap.has(waNumber)) {
    return waToTicketMap.get(waNumber);
  }

  try {
    const url = `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`;
    const payload = {
      ticket: {
        subject: `WhatsApp Conversation: ${waNumber}`,
        comment: { body: `New WhatsApp conversation started.\n\nCustomer: ${firstMessage}` },
        requester: { name: `WhatsApp ${waNumber}`, email: `wa-${waNumber}@example.com` },
        tags: ['whatsapp_channel'],
        priority: 'normal'
      }
    };

    const response = await axios.post(url, payload, { headers: getZendeskHeaders() });
    const ticketId = response.data.ticket.id;
    
    waToTicketMap.set(waNumber, ticketId);
    ticketToWaMap.set(ticketId.toString(), waNumber);
    
    console.log(`[Zendesk] Created new ticket #${ticketId} for ${waNumber}`);
    return ticketId;
  } catch (error) {
    console.error(`[Zendesk] Failed to create ticket:`, error.response?.data || error.message);
    return null;
  }
}

async function addTicketComment(ticketId, comment, isPublic = false, tags = []) {
  try {
    const url = `https://${process.env.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`;
    const payload = {
      ticket: {
        comment: {
          body: comment,
          public: isPublic
        }
      }
    };
    if (tags.length > 0) {
      payload.ticket.tags = tags;
    }
    
    await axios.put(url, payload, { headers: getZendeskHeaders() });
    console.log(`[Zendesk] Added comment to ticket #${ticketId}`);
  } catch (error) {
    console.error(`[Zendesk] Failed to add comment:`, error.response?.data || error.message);
  }
}

// ── Helpers for KopaDot API ─────────────────────────────────────────
async function getKopaDotResponse(waNumber, message) {
  try {
    const url = `${process.env.KOPADOT_API_URL}/api/chat`;
    const payload = {
      message: message,
      session_id: `wa-${waNumber}`,
      channel: 'whatsapp',
      customer: { phone: waNumber }
    };
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.KOPADOT_API_KEY
    };

    const response = await axios.post(url, payload, { headers });
    return response.data;
  } catch (error) {
    console.error(`[KopaDot] API failed:`, error.response?.data || error.message);
    return { error: true, response: "I'm having trouble connecting right now. A human will assist you shortly." };
  }
}

// ── WhatsApp Message Handler ────────────────────────────────────────
async function handleIncomingMessage(message) {
  if (message.isGroupMsg) return; // Ignore group messages

  const waNumber = message.from;
  const text = message.body;

  if (!text) return;

  console.log(`[WhatsApp] Received from ${waNumber}: ${text}`);

  // 1. Get or create Zendesk ticket
  const ticketId = await getOrCreateTicket(waNumber, text);
  if (ticketId && waToTicketMap.get(waNumber) === ticketId) {
    // If ticket already existed, log the new message as internal note
    // (So agents can read the customer's message)
    await addTicketComment(ticketId, `Customer (WhatsApp): ${text}`, false);
  }

  // 2. Check if AI is paused
  if (pausedNumbers.has(waNumber)) {
    console.log(`[WhatsApp] AI is paused for ${waNumber}, skipping KopaDot API.`);
    return;
  }

  // 3. Send to KopaDot API
  const aiResult = await getKopaDotResponse(waNumber, text);
  const replyText = aiResult.response;
  const escalated = aiResult.metadata?.escalated || aiResult.escalated || false;

  // 4. Send reply back to WhatsApp
  if (replyText) {
    await whatsappClient.sendText(waNumber, replyText);
    console.log(`[WhatsApp] Sent reply to ${waNumber}`);
    
    // 5. Log AI reply to Zendesk ticket
    await addTicketComment(ticketId, `KopaDot AI: ${replyText}`, false);
  }

  // 6. Handle Escalation
  if (escalated) {
    console.log(`[WhatsApp] Escalation triggered for ${waNumber}. Pausing AI.`);
    pausedNumbers.add(waNumber);
    await addTicketComment(ticketId, `⚠️ KopaDot AI has escalated this conversation to a human agent. The AI is now paused.\n\nPlease reply to the customer by adding a PUBLIC reply to this ticket.`, false, ['kopadot_escalated']);
  }
}

// ── Express Server for Zendesk Webhooks ─────────────────────────────
app.post('/zendesk/webhook', async (req, res) => {
  res.status(200).json({ ok: true }); // Respond quickly

  try {
    const { ticket_id, comment_body, is_public } = req.body;
    
    // We only care about public comments made by agents
    if (!is_public || is_public === 'false' || is_public === false) return;
    
    const waNumber = ticketToWaMap.get(ticket_id?.toString());
    if (!waNumber) {
      console.log(`[Webhook] Received comment for ticket #${ticket_id} but no mapped WA number.`);
      return;
    }

    const text = (comment_body || '').trim();

    // Check for agent unpause command
    if (text.toLowerCase() === '/resume') {
      console.log(`[Webhook] Agent sent /resume command. Unpausing AI for ${waNumber}.`);
      pausedNumbers.delete(waNumber);
      
      // Optionally notify the agent via an internal note that it was resumed
      await addTicketComment(ticket_id, `✅ AI has been resumed for this customer.`, false);
      return; // Don't send this command to the WhatsApp customer
    }

    // Check for agent pause command
    if (text.toLowerCase() === '/pause') {
      console.log(`[Webhook] Agent sent /pause command. Pausing AI for ${waNumber}.`);
      pausedNumbers.add(waNumber);
      
      await addTicketComment(ticket_id, `⏸️ AI has been manually paused for this customer. It will not reply to new messages.`, false);
      return; // Don't send this command to the WhatsApp customer
    }

    console.log(`[Webhook] Agent replied to ticket #${ticket_id}. Forwarding to ${waNumber}.`);
    
    // Forward agent's reply to WhatsApp
    if (whatsappClient) {
      await whatsappClient.sendText(waNumber, text);
      console.log(`[WhatsApp] Sent agent reply to ${waNumber}`);
    }

    // Ensure AI is paused since a human is talking
    pausedNumbers.add(waNumber);

  } catch (error) {
    console.error(`[Webhook] Error processing Zendesk webhook:`, error.message);
  }
});

// ── Initialization ──────────────────────────────────────────────────
async function start() {
  app.listen(PORT, () => {
    console.log(`[Express] Webhook server listening on port ${PORT}`);
  });

  try {
    whatsappClient = await wppconnect.create({
      session: 'kopadot-session',
      catchQR: (base64Qr, asciiQR) => {
        console.log('[WhatsApp] Scan this QR code to connect:');
        console.log(asciiQR);
      },
      statusFind: (statusSession, session) => {
        console.log('[WhatsApp] Status:', statusSession, session);
      },
      headless: true,
      logQR: false,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
      ],
    });

    console.log('[WhatsApp] Client successfully connected!');

    whatsappClient.onMessage((message) => {
      handleIncomingMessage(message).catch(err => {
        console.error('[WhatsApp] Error handling message:', err);
      });
    });

  } catch (error) {
    console.error('[WhatsApp] Failed to initialize WPPConnect:', error);
  }
}

start();
