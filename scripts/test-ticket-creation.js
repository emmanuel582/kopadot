import dotenv from 'dotenv';
dotenv.config();

import { createEscalationTicket } from '../src/tools/zendesk/tickets.js';

async function test() {
  console.log("Testing ticket creation...");
  const res = await createEscalationTicket({
    customer_name: "Test Customer",
    customer_email: "test@example.com",
    subject: "Test Ticket via API",
    summary: "This is a test summary",
    priority: "urgent"
  });
  console.log("Result:", res);
}

test().catch(console.error);
