/**
 * Enterprise Logger — Winston with structured JSON, file rotation.
 * Each log entry includes: timestamp, level, message, service, trackingId (if available).
 */
const winston = require('winston');
const path = require('path');
const fs = require('fs');
const config = require('../../config');

const LOG_DIR = config.paths.logs;
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, trackingId, ...meta }) => {
    const tid = trackingId ? ` [${trackingId}]` : '';
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}${tid} ${message}${extra}`;
  })
);

const logger = winston.createLogger({
  level: config.logLevel,
  format: logFormat,
  defaultMeta: { service: 'invoice-automation' },
  transports: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, maxFiles: 10, tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      maxsize: 10 * 1024 * 1024, maxFiles: 10, tailable: true,
    }),
  ],
});

if (config.nodeEnv !== 'production') {
  logger.add(new winston.transports.Console({ format: consoleFormat }));
} else {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
    level: 'warn',
  }));
}

/** Create a child logger bound to a specific tracking ID. */
function childLogger(trackingId) {
  return logger.child({ trackingId });
}

module.exports = { logger, childLogger };