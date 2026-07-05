# Invoice Automation Enterprise

## AI-Powered Invoice Processing with UUID Tracking, Circuit Breakers, and Dead Letter Queue

```
Supplier Email -> IMAP Monitor -> PDF Extract -> UUID + Tracking ID Stamp -> Groq AI Extract
    -> Validate & Clean -> Duplicate Check -> Airtable Store -> [Manual Review]
    -> Approval Routing (Cron + Email) -> Status Update -> Audit Trail
```

## Environment Variables (Only 5 Required)

```bash
GROQ_API_KEY=gsk_your_key_here       # Groq Cloud API key
SMTP_MAIL=your-email@gmail.com       # Used for BOTH IMAP (receive) and SMTP (send)
SMTP_PASSWORD=your-app-password       # Same password for IMAP + SMTP
SMTP_FROM=noreply@yourcompany.com     # From address for approval emails
PORT=3000                             # Server port (default: 3000)
```

IMAP host is auto-detected from the email domain:
- `gmail.com` -> `imap.gmail.com` / `smtp.gmail.com`
- `outlook.com` -> `outlook.office365.com` / `smtp.office365.com`
- `yahoo.com` -> `imap.mail.yahoo.com` / `smtp.mail.yahoo.com`
- Other domains -> `imap.{domain}` / `smtp.{domain}`

## Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AIRTABLE_API_KEY` | (empty) | Airtable API key — enables storage |
| `AIRTABLE_BASE_ID` | (empty) | Airtable base ID |
| `APPROVER_FINANCE` | (empty) | Finance approver email |
| `APPROVER_ENGINEERING` | (empty) | Engineering approver email |

Without Airtable credentials, the system runs in dry-run mode (logs all operations but doesn't write to Airtable).

## Tech Stack

| Component | Technology | Purpose |
|---|---|---|
| Runtime | Node.js 18+ | JavaScript runtime |
| AI Model | Groq `llama-3.3-70b-versatile` | Structured invoice extraction |
| Database | Airtable (optional) | Invoice storage + review UI + DLQ |
| Email | IMAP + Nodemailer (SMTP) | Inbound monitoring + approval emails |
| PDF | pdf-parse + pdf-lib | Text extraction + tracking ID watermarking |
| Scheduling | node-cron | Approval cycle (every 5 min) |
| Security | helmet + HMAC-signed tokens | HTTP hardening + approval auth |
| Resilience | Circuit Breaker + Token Bucket + DLQ | Fault tolerance |
| Logging | Winston (JSON + console) | Structured logging + file rotation |
| UUID | uuid v10 | Unique invoice UUID per PDF |

## Key Features

- **Unique Tracking ID** (`INV-YYYYMMDD-XXXX`) — date-based, no ambiguous chars
- **UUID v4 per Invoice** — embedded in PDF and stored in Airtable
- **Circuit Breaker** — prevents cascading failures (CLOSED -> OPEN -> HALF_OPEN)
- **Rate Limiting** — token bucket for Groq and Airtable APIs
- **Dead Letter Queue** — failed invoices never lost
- **Idempotency** — safe to restart without creating duplicates
- **Signed Approval Tokens** — HMAC-SHA256, 48h expiry, tamper-proof
- **15+ Validators** — amounts, dates, IBAN, VAT, line items, vendor name
- **IMAP Auto-Detection** — host derived from email domain

## Setup

```bash
cd invoice-automation
npm install
cp .env.example .env
# Edit .env — only 5 variables needed
npm run generate-samples   # Generate 4 test PDFs
NODE_ENV=test npm test     # Run 55+ tests
npm start                  # Start the server
```

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Full health status |
| GET | `/health/live` | Liveness probe |
| GET | `/health/ready` | Readiness probe |
| GET | `/api/invoices/:trackingId` | Get invoice by tracking ID |
| GET | `/api/invoices/:trackingId/action?token=X` | Approval/rejection webhook |
| POST | `/api/approvals/run` | Trigger approval cycle manually |

## Project Structure

```
invoice-automation/
  config/index.js              # 5 env vars, derives IMAP from SMTP
  src/
    app.js                     # Express server + service wiring
    core/worker.js             # Pipeline orchestrator with DLQ
    models/invoice.model.js    # Invoice, AuditEntry, DLQEntry
    services/
      email.service.js         # IMAP monitoring (Step 1)
      pdf.service.js           # Extract + ID stamping (Steps 2, 2b)
      ai.service.js            # Groq extraction + CB + rate limit (Step 3)
      cleaning.service.js      # 15+ validators (Step 4)
      storage.service.js       # Airtable CRUD + DLQ (Steps 5-6)
      approval.service.js      # Signed tokens + cron + email (Steps 8-9)
    utils/
      invoice-id.js            # Tracking ID + UUID + approval tokens
      logger.js                # Winston structured logging
      circuit-breaker.js       # Circuit breaker pattern
      rate-limiter.js          # Token bucket rate limiter
      validators.js            # 15+ composable validators
  prompts/invoice-extraction.md
  schema/airtable-schema.json  # 3 tables, 31 fields, 7 views
  sample-invoices/             # 4 generated PDFs with tracking IDs + UUIDs
  tests/
    run-all.test.js            # 55+ automated tests
    TEST_INPUTS_OUTPUTS.md     # Detailed test inputs & expected outputs
  attachments/                 # Stamped PDFs stored here
  logs/                        # Winston log files
  package.json
  .env.example
  README.md
```#
