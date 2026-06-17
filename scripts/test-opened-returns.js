import { processMessage } from '../src/agent/chatgptEngine.js';

async function runTest() {
  console.log("Starting Opened Returns Policy Override Test...");
  const message = "Hi, I received my Apple Pencil but it doesn't work with my iPad. I had to open the box to try it. I'd like to return it.";
  
  // We'll pass a mock session context to avoid missing email escalation issues
  const sessionContext = {
    channel: 'email',
    customerIdentity: {
      email: "test@example.com",
      name: "Test Customer"
    }
  };

  try {
    const result = await processMessage(message, [], sessionContext);
    
    console.log("Drafted Response from AI:\n", result.response);
    console.log("\nTools Used by AI:\n", JSON.stringify(result.toolsUsed, null, 2));
    
    const escalated = result.toolsUsed.some(t => t.name === 'createEscalationTicket');
    
    if (escalated) {
      console.log("\n✅ TEST PASSED: The AI correctly escalated the opened item return instead of rejecting it.");
      process.exit(0);
    } else {
      console.log("\n❌ TEST FAILED: The AI did not escalate the opened item return.");
      process.exit(1);
    }
  } catch (error) {
    console.error("Test execution failed:", error);
    process.exit(1);
  }
}

runTest();
