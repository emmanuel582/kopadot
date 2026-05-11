import { processMessage } from '../src/agent/chatgptEngine.js';

async function run() {
  console.log("Testing AI response...");
  const message = "My refurbished phone's screen has scratches from normal everyday use after 2 months — is this covered under warranty?";
  
  try {
    const result = await processMessage(message, [], { sessionId: 'test-123' });
    console.log("\n🤖 AI Response:\n", result.response);
    
    console.log("\n🔧 Tools Used:", result.toolsUsed.map(t => t.name).join(' -> ') || 'none');
    
    if (result.metadata && result.metadata.tools_used_details) {
      console.log("\n🛠️ Tool Results:");
      result.metadata.tools_used_details.forEach(t => {
        const preview = JSON.stringify(t.result).substring(0, 150);
        console.log(`  - ${t.name}: ${preview}...`);
      });
    }
  } catch (err) {
    console.error("Error:", err);
  }
}

run();
