import { zendeskRequest } from './client.js';
import { CACHE_TTL } from '../../config/constants.js';
import logger from '../../middleware/logger.js';

/**
 * Zendesk Knowledge Base Tools
 *
 * Search and retrieve help center articles for the AI to use
 * when answering policy, FAQ, and general questions.
 */

// ── In-Memory Article Cache ─────────────────────────────────────────
const articleCache = new Map();

function getCachedArticle(key) {
  const entry = articleCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL.KB_ARTICLES) {
    articleCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedArticle(key, data) {
  articleCache.set(key, { data, timestamp: Date.now() });
}

/**
 * Search the knowledge base for relevant articles.
 * @param {object} params - { query: string }
 * @returns {object} Search results with article snippets.
 */
export async function searchKnowledgeBase({ query }) {
  logger.info(`Searching knowledge base: "${query}"`);

  // Check cache
  const cacheKey = `search:${query.toLowerCase().trim()}`;
  const cached = getCachedArticle(cacheKey);
  if (cached) {
    logger.debug('Knowledge base cache hit');
    return cached;
  }

  try {
    const data = await zendeskRequest('/api/v2/help_center/articles/search.json', {
      query,
      per_page: 5,
    });

    const results = (data.results || []).map(article => ({
      article_id: article.id,
      title: article.title,
      snippet: article.snippet || stripHtml(article.body || '').slice(0, 300),
      url: article.html_url,
      section: article.section_id,
      labels: article.label_names || [],
      updated_at: article.updated_at,
    }));

    const response = {
      found: results.length > 0,
      count: results.length,
      articles: results,
      message: results.length > 0
        ? `Found ${results.length} relevant article(s) for "${query}".`
        : `No knowledge base articles found for "${query}". DO NOT GUESS OR PROVIDE GENERAL ADVICE. You MUST immediately call createEscalationTicket to connect the user with a human agent.`,
    };

    // Cache the results
    setCachedArticle(cacheKey, response);

    return response;
  } catch (error) {
    logger.error(`Knowledge base search failed: ${error.message}`);
    return {
      found: false,
      count: 0,
      articles: [],
      message: `Unable to search the knowledge base at this time. Error: ${error.message}. DO NOT GUESS OR PROVIDE GENERAL ADVICE. You MUST immediately call createEscalationTicket to connect the user with a human agent.`,
    };
  }
}

/**
 * Get the full content of a specific article.
 * @param {object} params - { article_id: string }
 * @returns {object} Full article content.
 */
export async function getArticle({ article_id }) {
  logger.info(`Fetching article: ${article_id}`);

  // Check cache
  const cacheKey = `article:${article_id}`;
  const cached = getCachedArticle(cacheKey);
  if (cached) return cached;

  try {
    const data = await zendeskRequest(`/api/v2/help_center/articles/${article_id}.json`);
    const article = data.article;

    if (!article) {
      return { found: false, message: `Article ${article_id} not found.` };
    }

    const response = {
      found: true,
      article_id: article.id,
      title: article.title,
      body: stripHtml(article.body || ''),
      url: article.html_url,
      section: article.section_id,
      labels: article.label_names || [],
      updated_at: article.updated_at,
      message: `Retrieved article: "${article.title}"`,
    };

    setCachedArticle(cacheKey, response);
    return response;
  } catch (error) {
    logger.error(`Article fetch failed: ${error.message}`);
    return {
      found: false,
      message: `Unable to retrieve article ${article_id}. Error: ${error.message}`,
    };
  }
}

/**
 * Strip HTML tags from article content, preserving readability.
 */
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default { searchKnowledgeBase, getArticle };
