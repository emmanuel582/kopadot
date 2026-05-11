import process from 'node:process';

const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const API_PATH = '/api/chat';

const hardQuestion = process.env.TEST_QUESTION || 'My order #784512 shows delivered but I never got it. I need either refund or reshipment, and I also want to cancel order #784520 if still processing. Please check payment because I might be charged twice, and tell me if policy exception is possible at day 35.';

async function run() {
  const payload = {
    message: hardQuestion,
    session_id: `test-${Date.now()}`,
  };

  const started = Date.now();

  try {
    const res = await fetch(`${BASE_URL}${API_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const elapsedMs = Date.now() - started;
    const data = await res.json();

    if (!res.ok) {
      console.error(`Chat test failed with HTTP ${res.status}`);
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }

    if (!data?.message || typeof data.message !== 'string') {
      console.error('Chat test failed: response missing "message" text.');
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }

    console.log('Chat test passed.');
    console.log(`URL: ${BASE_URL}${API_PATH}`);
    console.log(`Latency: ${elapsedMs}ms`);
    console.log(`Session: ${data.session_id || payload.session_id}`);
    console.log(`Reply preview: ${data.message.slice(0, 220)}${data.message.length > 220 ? '...' : ''}`);

    if (data.metadata) {
      console.log('Metadata:', JSON.stringify(data.metadata, null, 2));
    }
  } catch (error) {
    console.error('Chat test failed: could not reach API.');
    console.error(error?.message || error);
    process.exit(1);
  }
}

run();
