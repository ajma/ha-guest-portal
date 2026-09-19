# Build stage
FROM node:24-alpine AS builder

# Enable corepack and pin pnpm version
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /build

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source files
COPY . .

# Build the application
RUN pnpm build

# Runtime stage
# Note: We use node:24-alpine rather than the HA base image because this
# application requires Node ≥24 (package.json engines) for node:sqlite,
# which was added in Node 22.5. The HA base images ship Node 18-20 depending
# on the Alpine release, and none provide the built-in SQLite module this
# application's storage layer depends on. The add-on does not use bashio or
# s6-overlay (init: false in config.yaml; run.sh handles signals directly).
FROM node:24-alpine

# Install jq for JSON parsing in run.sh
RUN apk add --no-cache jq

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies
RUN npm install --omit=dev --ignore-scripts

# Copy built application from builder
COPY --from=builder /build/dist ./dist

# Copy run script
COPY addon/run.sh /
RUN chmod +x /run.sh

# Start script
CMD ["/run.sh"]
