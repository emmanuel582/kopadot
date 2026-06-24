import axios from 'axios';
import env from '../src/config/env.js';

/**
 * Test script to verify the KopaDot /api/chat endpoint
 * works correctly for the WhatsApp integration.
 */

async function testWhatsAppAPI() {
  console.log('Testing WhatsApp API Integration...');

  const payload = {
    message: "Hi, I ordered a phone but the delivery is delayed.",
    session_id: "wa-1234567890",
    channel: "whatsapp",
    customer: { phone: "1234567890" }
  };

  try {
    const url = `http://localhost:${env.port}/api/chat`;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': env.apiKey
    };

    console.log(`Sending POST to ${url}`);
    
    const response = await axios.post(url, payload, { headers });
    
    console.log('\n--- API Response ---');
    console.log('Response text:', response.data.response);
    console.log('Escalated flag:', response.data.metadata?.escalated);
    console.log('Paused flag:', response.data.metadata?.paused);
    console.log('Tools used:', response.data.metadata?.tools_used);
    console.log('--------------------\n');
    console.log('Test successful! The main application is correctly handling WhatsApp requests.');
    
  } catch (error) {
    console.error('Test failed:', error.response?.data || error.message);
    if (error.code === 'ECONNREFUSED') {
      console.log('Make sure the main KopaDot server is running (npm start).');
    }
  }
}

testWhatsAppAPI();
