/**
 * Circuit Breaker — Prevents cascading failures when external services are down.
 * States: CLOSED (normal) -> OPEN (failing) -> HALF_OPEN (probing recovery)
 */
const { logger } = require('./logger');

const STATE = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreaker {
  constructor({ fn, name = 'unnamed', timeout = 30000, failureThreshold = 5, resetTimeout = 30000, halfOpenMaxAttempts = 1 }) {
    this.fn = fn;
    this.name = name;
    this.timeout = timeout;
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.halfOpenMaxAttempts = halfOpenMaxAttempts;

    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.halfOpenAttempts = 0;
  }

  get isOpen() { return this.state === STATE.OPEN; }
  get isClosed() { return this.state === STATE.CLOSED; }
  get isHalfOpen() { return this.state === STATE.HALF_OPEN; }
  get status() {
    return { name: this.name, state: this.state, failures: this.failureCount, successes: this.successCount };
  }

  async execute(...args) {
    if (this.state === STATE.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        logger.info(`[CB:${this.name}] Transitioning OPEN -> HALF_OPEN`);
        this.state = STATE.HALF_OPEN;
        this.halfOpenAttempts = 0;
      } else {
        throw new Error(`[CB:${this.name}] Circuit is OPEN — service unavailable (retry after ${Math.ceil((this.resetTimeout - (Date.now() - this.lastFailureTime)) / 1000)}s)`);
      }
    }

    if (this.state === STATE.HALF_OPEN && this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
      throw new Error(`[CB:${this.name}] Circuit is HALF_OPEN — max probe attempts reached`);
    }

    try {
      const result = await this._runWithTimeout(...args);
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  _runWithTimeout(...args) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[CB:${this.name}] Timeout after ${this.timeout}ms`)), this.timeout);
      this.fn(...args).then(result => { clearTimeout(timer); resolve(result); }).catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  _onSuccess() {
    this.failureCount = 0;
    this.successCount++;
    if (this.state === STATE.HALF_OPEN) {
      logger.info(`[CB:${this.name}] HALF_OPEN -> CLOSED (recovered)`);
      this.state = STATE.CLOSED;
    }
  }

  _onFailure(err) {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === STATE.HALF_OPEN) {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        logger.warn(`[CB:${this.name}] HALF_OPEN -> OPEN (probe failed)`);
        this.state = STATE.OPEN;
      }
    } else if (this.failureCount >= this.failureThreshold) {
      logger.warn(`[CB:${this.name}] CLOSED -> OPEN (${this.failureCount} failures)`);
      this.state = STATE.OPEN;
    }
  }

  reset() {
    this.state = STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.halfOpenAttempts = 0;
  }
}

module.exports = { CircuitBreaker, STATE };