import https from 'https';
import logger from './middleware/logger.js';

/**
 * Render Free Tier Sleep Prevention
 * Free web services on Render spin down after 15 minutes of receiving no inbound web traffic.
 * Since email polling is outbound, it doesn't count as activity, causing the server to sleep
 * and email polling to stop until the next manual deploy or GitHub commit.
 * 
 * This script periodically pings the server's own health endpoint to keep it awake.
 */
export function startKeepAlive(url, intervalMins = 10) {
  if (!url) return;
  
  logger.info(`Starting self-ping keep-alive for ${url} every ${intervalMins} mins to prevent Render sleep`);
  
  setInterval(() => {
    https.get(url, (res) => {
      if (res.statusCode === 200) {
        logger.debug('Keep-alive ping successful (Server kept awake)');
      } else {
        logger.warn(`Keep-alive ping failed with status: ${res.statusCode}`);
      }
    }).on('error', (err) => {
      logger.error(`Keep-alive ping error: ${err.message}`);
    });
  }, intervalMins * 60 * 1000);
}
