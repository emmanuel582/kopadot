import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { triageInboundEmail, parseEmailHeaders } from '../src/channels/emailTriage.js';

const OWN = 'support@kopadot.com';

function headers(...pairs) {
  return parseEmailHeaders(pairs.map(([name, value]) => ({ name, value })));
}

describe('emailTriage Layer 1 — hard deny (zero GPT cost)', () => {
  it('skips Amazon donotreply shipping alerts', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'donotreply@amazon.com',
      subject: 'Amazon has shipped your sold item(s)',
      bodyPreview: 'Your package is on the way.',
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, false);
    assert.equal(result.layer, 1);
    assert.equal(result.gptUsed, false);
    assert.equal(result.reason, 'automated_sender_address');
  });

  it('skips platform marketplace notifications', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'seller-notifications@amazon.co.uk',
      subject: 'You have a new order, ship now',
      bodyPreview: 'A buyer purchased your item.',
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, false);
    assert.equal(result.layer, 1);
    assert.equal(result.gptUsed, false);
  });

  it('skips bulk marketing via List-Unsubscribe + List-Id headers', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'walmartmarketplace@comms.walmart.com',
      subject: 'Sell with Walmart and unlock global markets',
      bodyPreview: 'Grow your business with Walmart Marketplace.',
      headers: headers(
        ['List-Unsubscribe', '<https://walmart.com/unsub>'],
        ['List-Id', '<walmart.marketplace>'],
      ),
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, false);
    assert.equal(result.layer, 1);
    assert.equal(result.gptUsed, false);
    assert.equal(result.reason, 'platform_notification_sender');
  });
});

describe('emailTriage Layer 2 — signal scoring (zero GPT cost)', () => {
  it('replies to real customer order inquiry without GPT', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'emmanuelwritecode@gmail.com',
      subject: 'Order #32953972 — DPD shows delivered but I never got my Samsung Watch Ultra',
      bodyPreview: 'Hi KopaDot team, I placed order #32953972. DPD shows delivered but I have not received it. Can you confirm payment?',
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, true);
    assert.equal(result.layer, 2);
    assert.equal(result.gptUsed, false);
    assert.ok(result.customerScore >= 5);
  });

  it('replies to customer from a company domain', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'billing@acmecorp.com',
      subject: 'Refund request for order #88291',
      bodyPreview: 'Hello, we need a refund for order #88291 — the item arrived damaged. Please advise.',
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, true);
    assert.equal(result.layer, 2);
    assert.equal(result.gptUsed, false);
  });

  it('skips supplier stock offer without customer signals', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'inesa.zuber@smalltronic.pl',
      subject: 'Smalltronic Offer 09.10.2025',
      bodyPreview: 'Please find attached our latest WTS price list for mobile devices.',
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, false);
    assert.equal(result.layer, 2);
    assert.equal(result.gptUsed, false);
    assert.ok(result.marketingScore >= 5);
  });

  it('skips restock marketing nags', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'insights@amazon.co.uk',
      subject: 'Please restock to avoid a loss in sales.',
      bodyPreview: 'Your inventory is running low on several ASINs.',
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, false);
    assert.equal(result.gptUsed, false);
  });
});

describe('emailTriage — customer safety (must never block real queries)', () => {
  it('allows wholesale enquiry with customer signals through Layer 2', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'buyer@retailchain.co.uk',
      subject: 'Wholesale enquiry for order #44102',
      bodyPreview: 'Hello KopaDot team, we need help with a bulk order #44102. Can you advise on availability?',
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, true);
    assert.equal(result.gptUsed, false);
    assert.ok(result.customerScore >= 5);
  });

  it('does not hard-block when marketing headers present but customer asks for help', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'support@retailer.com',
      subject: 'Issue with my order #55001',
      bodyPreview: 'Hi, I have a problem with order #55001. The item arrived damaged. Please help with a return.',
      headers: headers(
        ['List-Unsubscribe', '<mailto:unsub@retailer.com>'],
        ['List-Id', '<retailer.support>'],
      ),
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, true);
    assert.notEqual(result.reason, 'high_marketing_score');
    assert.ok(result.customerScore >= 5);
  });

  it('never blocks vague help requests', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'jane.smith@outlook.com',
      subject: 'Need help',
      bodyPreview: 'Hi, I need some help please. Can someone get back to me?',
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, true);
    assert.notEqual(result.reason, 'marketing_signals_dominate');
    assert.notEqual(result.reason, 'high_marketing_score');
  });

  it('allows product question from personal email', async () => {
    const result = await triageInboundEmail({
      senderEmail: 'customer@gmail.com',
      subject: 'Is this item still in stock?',
      bodyPreview: 'Hello, I am interested in the Samsung Galaxy Watch. Is it available? What is your returns policy?',
    }, { ownMailbox: OWN });

    assert.equal(result.shouldRespond, true);
    assert.ok(result.customerScore >= 3);
  });
});
