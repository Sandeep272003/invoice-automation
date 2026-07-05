/**
 * AI Extraction Service — Step 3: Groq API integration with circuit breaker,
 * rate limiting, retry with exponential backoff, and structured output validation.
 */
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { logger, childLogger } = require('../utils/logger');
const { CircuitBreaker } = require('../utils/circuit-breaker');
const { TokenBucket } = require('../utils/rate-limiter');

class AIService {
  constructor() {
    this.client = null;
    this.systemPrompt = '';
    this.rateLimiter = new TokenBucket({ capacity: 10, refillRate: 5, refillIntervalMs: 1000, name: 'groq' });
    this.circuitBreaker = new CircuitBreaker({
      fn: (...args) => this._callGroqRaw(...args),
      name: 'groq-api',
      timeout: config.groq.timeout,
      failureThreshold: 5,
      resetTimeout: 60000,
    });
    this._stats = { calls: 0, successes: 0, failures: 0, avgLatencyMs: 0 };
  }

  init() {
    if (this.client) return;
    this.client = new Groq({ apiKey: config.groq.apiKey });
    this.systemPrompt = fs.readFileSync(path.join(config.paths.prompts, 'invoice-extraction.md'), 'utf8');
    this.rateLimiter.start();
    logger.info(`Groq AI service initialized — model: ${config.groq.model}`);
  }

  /**
   * Extract invoice data from text using Groq.
   * @param {string} text
   * @param {string} trackingId
   * @returns {Promise<object>}
   */
  async extract(text, trackingId) {
    const log = childLogger(trackingId);
    this.init();

    await this.rateLimiter.waitAndConsume();

    const maxLen = 18000;
    const input = text.length > maxLen ? text.substring(0, maxLen) + '\n[TRUNCATED]' : text;

    log.info(`Sending to Groq (${input.length} chars, model: ${config.groq.model})`);
    const start = Date.now();

    const raw = await this.circuitBreaker.execute(input);
    const parsed = this._parseAndValidate(raw);

    const latency = Date.now() - start;
    this._stats.calls++;
    this._stats.successes++;
    this._stats.avgLatencyMs = ((this._stats.avgLatencyMs * (this._stats.calls - 1)) + latency) / this._stats.calls;

    log.info(`Extracted in ${latency}ms — confidence: ${parsed.confidence}, vendor: ${parsed.vendor}, invoice#: ${parsed.invoice_number}`);
    return parsed;
  }

  async _callGroqRaw(inputText) {
    const response = await this.client.chat.completions.create({
      model: config.groq.model,
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: `Extract invoice data from the following text:\n\n---\n${inputText}\n---` },
      ],
      response_format: { type: 'json_object' },
      temperature: config.groq.temperature,
      max_tokens: config.groq.maxTokens,
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from Groq');
    return JSON.parse(content);
  }

  _parseAndValidate(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid extraction: expected JSON object');

    // Ensure confidence is 0-1
    raw.confidence = typeof raw.confidence === 'number'
      ? Math.min(1, Math.max(0, raw.confidence))
      : 0;

    // Clean line items
    if (Array.isArray(raw.line_items)) {
      raw.line_items = raw.line_items
        .filter(item => item && String(item.description || '').trim().length > 0)
        .map(item => ({
          description: String(item.description).trim(),
          quantity: item.quantity != null ? Math.round(parseFloat(item.quantity) * 100) / 100 : null,
          unit_price: item.unit_price != null ? Math.round(parseFloat(item.unit_price) * 100) / 100 : null,
          total: item.total != null ? Math.round(parseFloat(item.total) * 100) / 100 : null,
        }));
    } else {
      raw.line_items = [];
    }

    // Ensure anomalies is array
    raw.anomalies = Array.isArray(raw.anomalies) ? raw.anomalies.map(String) : [];

    return raw;
  }

  get status() {
    return {
      model: config.groq.model,
      circuitBreaker: this.circuitBreaker.status,
      rateLimiter: this.rateLimiter.status,
      stats: { ...this._stats },
    };
  }
}

module.exports = { AIService };