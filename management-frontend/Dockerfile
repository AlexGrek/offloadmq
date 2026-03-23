# Build stage - Build frontend with Node 24
FROM node:24 AS builder
WORKDIR /build

# Copy source and dependencies
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Build Vite SPA with base path for /ui deployment
ARG VITE_BASE_PATH=/ui/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
RUN npm run build

# Runtime stage - Minimal server container
FROM node:24-alpine
WORKDIR /app

# Install only production dependencies for server
COPY server/package*.json ./
RUN npm install --omit=dev

# Copy built frontend from builder
COPY --from=builder /build/dist ./dist

# Copy server
COPY server/server.js ./

# Set environment variables
ENV PORT=8080
ENV API_TARGET=http://backend:5000
ENV MGMT_TARGET=http://backend:5001

EXPOSE 8080
CMD ["node", "server.js"]
