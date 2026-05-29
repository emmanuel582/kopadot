import axios from 'axios';
import env from '../src/config/env.js';
import { createEscalationTicket } from '../src/tools/zendesk/tickets.js';
import { processMessage } from '../src/agent/chatgptEngine.js';
import logger from '../src/middleware/logger.js';

async function fetchSunshineUserEmail(userId) {
  if (!env.sunshineAppId || !env.sunshineKeyId || !env.sunshineKeySecret) {
    console.error('Missing Sunshine credentials');
    return null;
  }

  const url = `https://${env.zendeskSubdomain}.zendesk.com/sc/v2/apps/${env.sunshineAppId}/users/${userId}`;
  const auth = Buffer.from(`${env.sunshineKeyId}:${env.sunshineKeySecret}`).toString('base64');

  try {
    const response = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 5000,
    });
    return response.data?.user?.profile?.email || null;
  } catch (error) {
    console.error(`Failed to fetch email for Sunshine user ${userId}: ${error.message}`);
    return null;
  }
}

async function runTests() {
  console.log('--- 1. Testing Sunshine Conversations Email Fetch ---');
  // Use the known ID from the logs
  const testUserId = '6a19fff03587d29238c166a6'; 
  const email = await fetchSunshineUserEmail(testUserId);
  console.log(`Fetched email for user ${testUserId}: ${email}`);
  if (email === 'yoans@gmail.com') {
    console.log('✅ Email fetch successful!');
  } else {
    console.error('❌ Email fetch failed or returned incorrect email.');
  }

  console.log('\n--- 2. Testing Zendesk Ticket Creation with Tags ---');
  try {
    const ticketResult = await createEscalationTicket({
      customer_name: 'Yeoans Test',
      customer_email: 'yoans@gmail.com',
      subject: 'Test Refund Request',
      summary: 'The customer wants a refund for their recent order.',
      priority: 'high',
      tags: ['refund', 'test_script_run']
    });
    console.log('Ticket creation result:', ticketResult);
    if (ticketResult.success) {
      console.log('✅ Ticket created successfully with tags!');
    }
  } catch (err) {
    console.error('❌ Ticket creation failed:', err);
  }

  console.log('\n--- 3. Testing AI Engine Escalation Flow ---');
  try {
    // Simulate user asking for human without an email
    console.log('\nUser: "I want to speak with a human" (No email provided context)');
    const resultNoEmail = await processMessage('I want to speak with a human', [], {
      sessionId: 'test_session_1',
      channel: 'live_chat',
      customerIdentity: { name: 'Yeoans', email: null },
    });
    console.log(`AI Response: ${resultNoEmail.response}`);
    console.log(`Tools Used:`, resultNoEmail.toolsUsed.map(t => t.name));
    
    // Simulate user asking for human WITH an email
    console.log('\nUser: "I want to speak with a human" (Email provided context)');
    const resultWithEmail = await processMessage('I want to speak with a human', [], {
      sessionId: 'test_session_2',
      channel: 'live_chat',
      customerIdentity: { name: 'Yeoans', email: 'yoans@gmail.com' },
    });
    console.log(`AI Response: ${resultWithEmail.response}`);
    console.log(`Tools Used:`, resultWithEmail.toolsUsed.map(t => t.name));
    
    // Check if the ticket creation tool was called with tags
    const escalateCall = resultWithEmail.toolsUsed.find(t => t.name === 'createEscalationTicket');
    if (escalateCall) {
      console.log('Escalation arguments:', escalateCall.args);
    }
  } catch (err) {
    console.error('❌ AI testing failed:', err);
  }
}

runTests();
