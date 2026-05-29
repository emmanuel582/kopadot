import { processMessage } from '../src/agent/chatgptEngine.js';

async function runTest() {
  const message = "Hi! I recently placed order 31844349 for a Pixel Watch. I noticed it hasn't shipped yet. What is your policy on cancelling an order before it ships? Also, if I do cancel it, do you have any pink smartwatches under £200 that I could buy instead?";
  
  console.log("=== SENDING MESSAGE TO AI ===");
  console.log(message);
  console.log("===============================\n");

  const response = await processMessage(
    message,
    [], // empty conversation history
    { CUSTOMER_EMAIL_STATUS: 'AVAILABLE', customerIdentity: { email: 'test.user@example.com' } }
  );

  console.log("\n=== AI RESPONSE ===");
  console.log(JSON.stringify(response, null, 2));
  console.log("===================");
}

runTest().catch(console.error);
