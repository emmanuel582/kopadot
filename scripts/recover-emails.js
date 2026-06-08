import env from '../src/config/env.js';
import emailService from '../src/channels/email.js';

async function recover() {
  console.log("Initializing Graph client...");
  const initResult = await emailService.verifyGraphConnection();
  if (!initResult.ok) {
    console.error("Failed to init Graph", initResult.reason);
    return;
  }

  console.log("Processing missed email...");
  try {
    const res = await emailService.replyToSpecificEmail({ 
      fromEmail: 'bukkyglory2020@gmail.com',
      subjectContains: 'Missing tracking',
      force: true
    });
    console.log("Result:", res);
  } catch(e) {
    console.error(e.message);
  }
}

recover().then(() => process.exit(0)).catch(console.error);
