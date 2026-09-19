# syntax=docker/dockerfile:1
FROM node:24-alpine AS builder

# Enable corepack and pin pnpm version
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /build

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies (pnpm-workspace.yaml not needed - only used for allowBuilds in development)
RUN pnpm install --frozen-lockfile

# Copy source files
COPY . .

# Build the application
RUN pnpm build

# Runtime stage
FROM node:24-alpine

# Enable corepack and pin pnpm version
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only (pnpm-workspace.yaml not needed at runtime)
RUN pnpm install --prod --frozen-lockfile

# Copy built files from builder
COPY --from=builder /build/dist ./dist

# Create /data directory and set ownership to node user
RUN mkdir -p /data && chown -R node:node /data

# Declare volume for persistent data
VOLUME /data

# Switch to non-root user
USER node

# Expose the default port
EXPOSE 8080

# Configure healthcheck
# Reports process health, not HA connectivity - see GET /api/health comment
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || '8080') + '/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the application
CMD ["node", "dist/server/index.js"]
