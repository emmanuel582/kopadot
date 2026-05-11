import 'dotenv/config';
import { processMessage } from '../src/agent/chatgptEngine.js';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const sessionContext = {
  channel: 'test_cli'
};
let conversationHistory = [];

console.log('🤖 KopaDot Agent Testing Session');
console.log('Type your message and press Enter. Type "exit" to quit.');
console.log('------------------------------------------------------');

const prompt = () => {
  rl.question('You: ', async (message) => {
    if (message.toLowerCase() === 'exit') {
      rl.close();
      return;
    }

    try {
      const { response, toolsUsed, conversationUpdate, metadata } = await processMessage(
        message, 
        conversationHistory, 
        sessionContext
      );

      console.log(`\nAgent: ${response}`);
      
      if (toolsUsed && toolsUsed.length > 0) {
        console.log(`\n[Tools Used: ${toolsUsed.map(t => t.name).join(', ')}]`);
      }
      if (metadata && metadata.blocked_by_guardrail) {
        console.log(`\n[Guardrail Blocked: ${metadata.reason}]`);
      }

      console.log('------------------------------------------------------');
      
      // Update history
      if (conversationUpdate) {
        conversationHistory = conversationHistory.concat(conversationUpdate);
      }
    } catch (err) {
      console.error('Error:', err.message);
    }
    
    prompt();
  });
};

prompt();
