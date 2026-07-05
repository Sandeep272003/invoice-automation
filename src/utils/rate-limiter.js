/**
 * Rate Limiter — Token-bucket for Groq and Airtable API rate limiting.
 * Pure in-memory implementation, no external dependency.
 */
const { logger } = require('./logger');

class TokenBucket {
  constructor({ capacity = 5, refillRate = 5, refillIntervalMs = 1000, name = 'bucket' }) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.refillIntervalMs = refillIntervalMs;
    this.name = name;
    this.tokens = capacity;
    this.lastRefill = Date.now();
    this._interval = null;
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this._refill(), this.refillIntervalMs);
    this._interval.unref();
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = Math.min(this.capacity, (elapsed / this.refillIntervalMs) * this.refillRate);
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  consume(cost = 1) {
    this._refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    logger.debug(`[RateLimiter:${this.name}] Rate limited — ${this.tokens.toFixed(1)} tokens remaining, needed ${cost}`);
    return false;
  }

  async waitAndConsume(cost = 1, maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (this.consume(cost)) return true;
      await new Promise(r => setTimeout(r, Math.min(this.refillIntervalMs, 100)));
    }
    throw new Error(`[RateLimiter:${this.name}] Timed out waiting for tokens after ${maxWaitMs}ms`);
  }

  get remaining() { this._refill(); return this.tokens; }
  get status() { return { name: this.name, tokens: this.remaining.toFixed(1), capacity: this.capacity }; }
}

module.exports = { TokenBucket };