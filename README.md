# KopaDot — AI E-Commerce Support Agent

> **An autonomous AI agent powered by Google Gemini that handles all customer queries for e-commerce businesses, using BaseLinker as the central data hub and Zendesk as the knowledge base.**

---

## Project Vision

Build a production-grade AI support agent that:
- **Understands customer intent** via Gemini's native reasoning
- **Calls tools dynamically** (BaseLinker API, Zendesk KB) to fetch real answers
- **Resolves 80%+ of tickets autonomously** — order tracking, returns, product questions, policies
- **Escalates intelligently** to human agents with full context when needed

---

## Architecture Overview

```
 CUSTOMER CHANNELS
   Live Chat | Email | WhatsApp | Social DMs | Website
                       |
                       v
 ORCHESTRATION LAYER (Node.js)
  +--------------+  +--------------+  +---------------+
  | Channel      |  | Session &    |  | Rate Limiter  |
  | Normalizer   |  | Memory Mgr   |  | & Auth        |
  +------+-------+  +------+-------+  +---------------+
         |                 |
         v                 v
  +---------------------------------------------+
  |      GEMINI AI ENGINE (gemini-2.5-flash)    |
  |                                              |
  |  - Intent Classification                    |
  |  - Entity Extraction (order_id, email, SKU) |
  |  - Tool Selection & Execution               |
  |  - Response Generation                      |
  |  - Escalation Decision                      |
  +------------------+----+----+-----------------+
                     |    |    |
         +-----------+    |    +-----------+
         v                v                v
  +------------+   +---------+
  | BaseLinker |   | Zendesk |
  | Tools      |   | KB Tool |
  +------------+   +---------+
         |              |
         v              v
  EXTERNAL SERVICES
  BaseLinker API | Zendesk Help Center API
```

---

## Research Findings

### 1. BaseLinker API (Central E-Commerce Hub)

**Endpoint:** `POST https://api.baselinker.com/connector.php`
**Auth:** `X-BLToken` header | **Rate Limit:** 100 req/min

#### API Categories & Key Methods

| Category | Methods | Use Case |
|----------|---------|----------|
| **Orders** | `getOrders`, `getOrdersByEmail`, `getOrdersByPhone`, `getOrderStatusList`, `getOrderPaymentsHistory`, `getOrderTransactionData` | Order lookup, status checks, payment history |
| **Shipping** | `getOrderPackages`, `getCourierPackagesStatusHistory`, `getCouriersList`, `getLabel`, `getPackageDetails` | Tracking, delivery status, courier info |
| **Returns** | `getOrderReturns`, `addOrderReturn`, `getOrderReturnStatusList`, `getOrderReturnReasonsList`, `setOrderReturnRefund` | Return initiation, refund status |
| **Products** | `getProductsList`, `getProductsData`, `getInventoryProductsStock`, `getInventoryProductsPrices` | Product info, availability, pricing |
| **Inventory** | `getInventories`, `getInventoryWarehouses`, `getInventoryCategories` | Stock levels, warehouse info |
| **External Stores** | `getExternalStoragesList`, `getExternalStorageProductsData`, `getExternalStorageProductsQuantity` | Multi-channel product sync |
| **CRM** | `getCrmClients`, `getCrmClientData`, `addCrmClient` | Customer profiles, history |
| **Invoices** | `getInvoices`, `getInvoiceFile`, `addInvoice` | Invoice retrieval |

### 2. Zendesk Knowledge Base API

**Search Endpoint:** `GET /api/v2/help_center/articles/search?query={term}`
**Auth:** API Token via Admin Center

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v2/help_center/articles/search` | Search KB articles (public, no auth needed) |
| `GET /api/v2/guide/search` | Unified search across articles + posts (auth required) |
| `GET /api/v2/help_center/articles/{id}` | Fetch specific article |
| `GET /api/v2/help_center/sections` | List all sections/categories |

### 3. Zendesk Ticketing Integration

- Use Zendesk ticket APIs for escalations from the AI agent
- Include conversation transcript + summary when escalating
- Route urgent issues with higher priority tags

### 4. Gemini Function Calling (Tool Use)

Gemini natively supports structured tool declarations:

```javascript
const tools = [{
  functionDeclarations: [{
    name: 'getOrderStatus',
    description: 'Look up order status and tracking by order ID or email',
    parameters: {
      type: 'OBJECT',
      properties: {
        order_id: { type: 'STRING', description: 'The order ID' },
        email: { type: 'STRING', description: 'Customer email address' }
      }
    }
  }]
}];
```

**Flow:** User query -> Gemini classifies intent -> Returns `functionCall` -> App executes tool -> Result sent back -> Gemini generates natural language response.

---

## Intent Classification Map

| Intent | Trigger Examples | Tools Called | Priority |
|--------|-----------------|-------------|----------|
| `order_status` | "Where is my order?", "Track #12345" | `getOrders`, `getOrderPackages` | HIGH |
| `return_request` | "I want to return this", "Wrong item" | `getOrders`, `addOrderReturn`, `getOrderReturnReasonsList` | HIGH |
| `refund_status` | "Where is my refund?" | `getOrderReturns`, `getOrderReturnPaymentsHistory` | HIGH |
| `product_inquiry` | "Do you have X in stock?" | `getProductsData`, `getInventoryProductsStock` | MEDIUM |
| `shipping_info` | "How long does delivery take?" | Zendesk KB search | MEDIUM |
| `payment_issue` | "Payment failed", "Double charged" | `getOrderPaymentsHistory`, `getOrderTransactionData` | HIGH |
| `cancel_order` | "Cancel my order" | `getOrders`, `setOrderStatus` | HIGH |
| `invoice_request` | "Send me my invoice" | `getInvoiceFile`, `getInvoices` | LOW |
| `product_complaint` | "Item is broken" | `getOrders`, `addOrderReturn` | HIGH |
| `policy_question` | "What's your return policy?" | Zendesk KB search | LOW |
| `account_help` | "Update my address" | `getCrmClientData`, Zendesk ticket escalation if needed | MEDIUM |
| `general_faq` | "Opening hours?" | Zendesk KB search | LOW |
| `escalate_human` | "Talk to a person" | Route to Zendesk human agent | IMMEDIATE |

---

## Build Plan

### Phase 1: Foundation (Week 1-2)

#### 1.1 Project Structure
```
KopaDot/
├── src/
│   ├── index.js              # Express server entry point
│   ├── config/
│   │   ├── env.js            # Environment variables
│   │   └── constants.js      # Intent enums, status codes
│   ├── agent/
│   │   ├── geminiEngine.js   # Gemini API client + function calling
│   │   ├── toolRegistry.js   # Tool declaration registry
│   │   ├── conversationMgr.js # Session memory & context
│   │   └── escalation.js     # Human handoff logic
│   ├── tools/
│   │   ├── baselinker/
│   │   │   ├── client.js     # BaseLinker HTTP client (rate-limited)
│   │   │   ├── orders.js     # Order-related tool functions
│   │   │   ├── shipping.js   # Tracking & courier tools
│   │   │   ├── returns.js    # Returns & refunds tools
│   │   │   ├── products.js   # Product catalog tools
│   │   │   └── crm.js        # Customer data tools
│   │   ├── zendesk/
│   │   │   ├── client.js     # Zendesk API client
│   │   │   └── knowledgeBase.js # Article search & retrieval
│   │   └── zendesk/
│   │       └── tickets.js    # Ticket creation & routing
│   ├── channels/
│   │   ├── webhook.js        # Incoming message webhook handler
│   │   ├── livechat.js       # WebSocket live chat
│   │   └── email.js          # Email channel processor
│   ├── middleware/
│   │   ├── auth.js           # API key / webhook signature validation
│   │   ├── rateLimiter.js    # Per-customer rate limiting
│   │   └── logger.js         # Request/response logging
│   └── utils/
│       ├── entityExtractor.js # Pre-extract order IDs, emails, SKUs
│       └── responseFormatter.js # Clean Gemini output for channels
├── tests/
├── .env.example
├── package.json
└── README.md
```

#### 1.2 Core Dependencies
```json
{
  "dependencies": {
    "@google/genai": "latest",
    "express": "^4.18",
    "axios": "^1.6",
    "bottleneck": "^2.19",
    "ws": "^8.16",
    "dotenv": "^16.3",
    "winston": "^3.11",
    "helmet": "^7.1",
    "cors": "^2.8"
  }
}
```

#### 1.3 Environment Variables
```env
GEMINI_API_KEY=
BASELINKER_API_TOKEN=
ZENDESK_SUBDOMAIN=
ZENDESK_API_TOKEN=
ZENDESK_EMAIL=
PORT=3000
NODE_ENV=production
```

### Phase 2: BaseLinker Integration (Week 2-3)

**2.1 Rate-Limited Client**
- HTTP POST client with `X-BLToken` header
- Bottleneck rate limiter: max 90 req/min (safety margin)
- Auto-retry with exponential backoff on 429/5xx errors
- Response caching for `getOrderStatusList`, `getCouriersList` (refresh every 15 min)

**2.2 Tool Functions to Implement**

| Tool Function | BaseLinker Method(s) | Input | Output |
|--------------|---------------------|-------|--------|
| `lookupOrder` | `getOrders` / `getOrdersByEmail` / `getOrdersByPhone` | order_id OR email OR phone | Order details, items, status |
| `trackShipment` | `getOrderPackages`, `getCourierPackagesStatusHistory` | order_id | Tracking URL, status, carrier |
| `initiateReturn` | `addOrderReturn`, `addOrderReturnProduct` | order_id, reason, items | Return confirmation |
| `checkReturnStatus` | `getOrderReturns` | order_id or return_id | Return status, refund status |
| `getProductInfo` | `getProductsData`, `getInventoryProductsStock` | product_name or SKU | Price, availability, description |
| `getPaymentHistory` | `getOrderPaymentsHistory` | order_id | Payment status, amounts, dates |
| `getInvoice` | `getInvoiceFile` | order_id | Invoice PDF download link |
| `getCustomerProfile` | `getCrmClientData` | email or phone | Purchase history, account info |

### Phase 3: Zendesk KB Integration (Week 3)

- Search articles via `GET /api/v2/help_center/articles/search`
- Cache top articles locally (refresh every hour)
- RAG approach: embed articles, vector search, pass relevant chunks to Gemini
- Fallback: direct API search if vector store unavailable
- Index: Shipping, Returns, Payment, Product care, Warranty, FAQ, Size guides

### Phase 4: Gemini Agent Engine (Week 3-4)

**4.1 System Prompt Design**
```
You are KopaDot, a friendly and professional AI customer support agent
for [STORE_NAME]. You help customers with orders, shipping, returns,
product questions, and general inquiries.

RULES:
1. Always verify customer identity before sharing order details
2. Use tools to get REAL data - never make up order statuses or tracking
3. If unsure, search the knowledge base before saying "I don't know"
4. Escalate to human agents for: complaints with strong negative sentiment,
   requests for exceptions to policy, technical issues you cannot resolve
5. Be empathetic, concise, and proactive (suggest next steps)
6. Never share other customers' data
7. Always confirm actions before executing (e.g. "Shall I initiate this return?")
```

**4.2 Function Calling Loop**
```
1. Receive customer message
2. Load conversation history (last 20 messages)
3. Send to Gemini with tool declarations
4. IF Gemini returns functionCall:
   a. Execute the tool function
   b. Send result back as functionResponse
   c. Gemini generates natural language answer
5. IF Gemini returns text:
   a. Send directly to customer
6. IF escalation detected:
   a. Create Zendesk ticket with full transcript
   b. Route to appropriate agent team
   c. Inform customer of handoff
```

**4.3 Multi-Turn Conversation Memory**
- Redis-backed session store (TTL: 2 hours)
- Store: customer identity, extracted entities, conversation history
- Pass last 20 messages as context to Gemini on each turn

### Phase 5: Channel Integration (Week 4-5)

- **Live Chat:** WebSocket server on `/ws/chat`, typing indicators, reconnection
- **Email:** Webhook receiver, email-to-conversation threading, HTML formatting
- **WhatsApp (Future):** Business API webhook, template compliance, media handling

### Phase 6: Safety & Governance (Week 5-6)

- PII redaction in logs (mask emails, phones, addresses)
- Webhook signature verification, input sanitization (prompt injection defense)
- Token budget per conversation, max 5 tool calls per turn
- Confidence threshold: if certainty < 70%, escalate to human
- Observability dashboard: resolution rate, avg response time, CSAT, error rate

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **AI Model** | Gemini 2.5 Flash | Fast, cheap, excellent function calling |
| **Runtime** | Node.js + Express | Non-blocking I/O, WebSocket native |
| **Data Hub** | BaseLinker | Already connects all e-commerce channels |
| **Knowledge Base** | Zendesk Help Center | Existing KB, public search API |
| **Helpdesk** | Zendesk | Ticket management, human agent routing |
| **Session Store** | Redis | Fast TTL, pub/sub for real-time |
| **Rate Limiting** | Bottleneck | Proven library for BaseLinker's 100/min |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Autonomous Resolution Rate | > 80% |
| First Response Time | < 3 seconds |
| Customer Satisfaction (CSAT) | > 4.2/5 |
| Hallucination Rate | < 1% |
| Escalation Rate | < 20% |
| Avg. Conversation Duration | < 4 minutes |

---

## Getting Started

```bash
# 1. Clone and install
cd KopaDot
npm install

# 2. Configure environment
cp .env.example .env
# Fill in API keys for Gemini, BaseLinker, Zendesk

# 3. Run development server
npm run dev

# 4. Run real-life production smoke test scenarios
npm run test:prod

# 5. Test with curl
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Where is my order #12345?", "session_id": "test-1"}'
```

---

## Timeline Summary

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1. Foundation | Week 1-2 | Project structure, Express server, Gemini client |
| 2. BaseLinker | Week 2-3 | All 8 tool functions, rate-limited client |
| 3. Zendesk KB | Week 3 | Article search tool, RAG pipeline |
| 4. Agent Engine | Week 3-4 | Function calling loop, memory, escalation |
| 5. Channels | Week 4-5 | Live chat WebSocket, email processing |
| 6. Safety | Week 5-6 | PII redaction, guardrails, monitoring |
| 7. Testing & Launch | Week 6-7 | Load testing, A/B testing, production deploy |

---

*Research completed: April 27, 2026*
*Sources: BaseLinker API docs, Zendesk Developer Portal, Google Gemini AI docs*
