import { replyToSpecificEmail } from './src/channels/email.js';

async function main() {
  try {
    const res = await replyToSpecificEmail({
      fromEmail: 'emmanuelwritecode@gmail.com',
      force: true
    });
    console.log("Result:", res);
  } catch (err) {
    console.error("Error:", err);
  }
  process.exit(0);
}

main();
