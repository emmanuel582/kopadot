import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch'; // Required for microsoft-graph-client in Node
import OpenAI from 'openai';
import env from '../config/env.js';
import logger from '../middleware/logger.js';
import { processMessage } from '../agent/chatgptEngine.js';
import { getSession } from '../agent/conversationMgr.js';

const openai = new OpenAI({ apiKey: env.openaiApiKey });

// Microsoft Graph Auth Setup
let graphClient = null;

function getGraphClient() {
  if (graphClient) return graphClient;

  if (!env.msGraphTenantId || !env.msGraphClientId || !env.msGraphClientSecret || !env.msGraphUserId) {
    logger.error('Microsoft Graph credentials are not fully configured in environment variables.');
    return null;
  }

  const msalConfig = {
    auth: {
      clientId: env.msGraphClientId,
      authority: `https://login.microsoftonline.com/${env.msGraphTenantId}`,
      clientSecret: env.msGraphClientSecret,
    }
  };

  const cca = new ConfidentialClientApplication(msalConfig);

  const authProvider = async (done) => {
    try {
      const authResponse = await cca.acquireTokenByClientCredential({
        scopes: ['https://graph.microsoft.com/.default'],
      });
      done(null, authResponse.accessToken);
    } catch (error) {
      logger.error(`Error acquiring token: ${error.message}`);
      done(error, null);
    }
  };

  graphClient = Client.init({
    authProvider,
  });

  return graphClient;
}

/**
 * Uses LLM to classify if an email is a complaint.
 * @param {string} subject 
 * @param {string} bodyPreview 
 * @returns {Promise<boolean>} true if complaint, false otherwise
 */
async function isComplaint(subject, bodyPreview) {
  try {
    const response = await openai.chat.completions.create({
      model: env.openaiModel,
      messages: [
        {
          role: 'system',
          content: `You are an email classification AI. Analyze the email subject and preview. 
Determine if the email is a COMPLAINT (expressing dissatisfaction, anger, asking for a refund due to poor quality, missing items, damaged goods, late delivery, etc.).
General questions (e.g., "Where is my order?", "How to return?") are NOT complaints unless accompanied by frustration or negative sentiment.
Respond ONLY with a JSON object: {"is_complaint": true/false}`
        },
        {
          role: 'user',
          content: `Subject: ${subject}\n\nPreview:\n${bodyPreview}`
        }
      ],
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(response.choices[0].message.content);
    return result.is_complaint;
  } catch (error) {
    logger.warn(`Failed to classify email: ${error.message}`, error);
    // If classification fails, assume false to be safe and avoid sending wrong AI replies
    return false; 
  }
}

/**
 * Fetches unread emails, classifies them, processes complaints, and marks all as read.
 */
async function pollEmails() {
  const client = getGraphClient();
  if (!client) return;

  try {
    logger.debug('Polling Microsoft 365 for new emails...');
    
    const response = await client
      .api(`/users/${env.msGraphUserId}/messages`)
      .filter('isRead eq false')
      .select('id,subject,bodyPreview,from,body,conversationId')
      .top(10)
      .get();

    const messages = response.value || [];
    
    if (messages.length === 0) {
      return;
    }

    logger.info(`Found ${messages.length} unread email(s). Processing...`);

    for (const msg of messages) {
      // 1. Check if it's a complaint
      const complaint = await isComplaint(msg.subject, msg.bodyPreview);
      
      if (complaint) {
        logger.info(`Email identified as a COMPLAINT. Subject: "${msg.subject}". Processing...`);
        
        // Use the conversationId or a hash of the sender's email as the session ID
        const senderEmail = msg.from?.emailAddress?.address;
        const sessionId = `email-${msg.conversationId || senderEmail || msg.id}`;
        
        // Strip HTML from the body for the agent if needed, or just pass text
        // Graph API can return text or HTML body. We'll use the text content if available, 
        // but for simplicity we'll pass the content to the agent.
        const contentToProcess = msg.body?.content || msg.bodyPreview;
        
        // Get conversation context
        const session = getSession(sessionId, { channel: 'email' });
        if (senderEmail) {
          session.customerIdentity.email = senderEmail;
        }

        const agentResult = await processMessage(
          `Subject: ${msg.subject}\n\n${contentToProcess}`, 
          session.conversationHistory, 
          { channel: 'email', emailAddress: senderEmail }
        );

        // Send Reply
        if (agentResult.response) {
          logger.info(`Sending reply for email: ${msg.subject}`);
          const replyBody = {
            message: {
              body: {
                contentType: 'text',
                content: agentResult.response
              }
            }
          };
          
          await client
            .api(`/users/${env.msGraphUserId}/messages/${msg.id}/reply`)
            .post(replyBody);
        }

        // Add to history
        if (agentResult.conversationUpdate) {
          session.conversationHistory.push(...agentResult.conversationUpdate);
        }
      } else {
        logger.debug(`Email is NOT a complaint. Ignoring. Subject: "${msg.subject}"`);
      }

      // Mark as read regardless of whether it's a complaint or not
      await client
        .api(`/users/${env.msGraphUserId}/messages/${msg.id}`)
        .patch({ isRead: true });
    }

  } catch (error) {
    logger.error(`Error polling Microsoft 365 emails: ${error.message}`, { stack: error.stack });
  }
}

/**
 * Starts the polling loop.
 * @param {number} intervalMs - Polling interval in milliseconds. Default: 10 mins.
 */
export function startEmailPolling(intervalMs = 10 * 60 * 1000) {
  logger.info(`Starting Microsoft 365 Email Polling every ${intervalMs / 60000} minutes...`);
  // Poll immediately on startup
  pollEmails();
  
  // Then start the interval
  setInterval(pollEmails, intervalMs);
}

export default { startEmailPolling };
