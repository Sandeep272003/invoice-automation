FROM node:20-slim

# Install build dependencies for better-sqlite3 (native C++ addon)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy source code
COPY config/ ./config/
COPY src/ ./src/
COPY prompts/ ./prompts/
COPY schema/ ./schema/

# Create runtime directories
RUN mkdir -p /app/data /app/attachments /app/logs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health/live', r => { r.statusCode === 200 ? process.exit(0) : process.exit(1) }).on('error', () => process.exit(1))"

# Start the application
CMD ["node", "src/app.js"]