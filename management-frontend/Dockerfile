# Build stage
FROM node:24 AS build
WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Build Vite SPA
RUN npm run build

# Runtime stage
FROM node:24-slim
WORKDIR /app

# Install production dependencies for the server only
COPY server/package*.json ./
RUN npm install --omit=dev

# Copy built frontend and server
COPY --from=build /app/dist ./dist
COPY server/server.js ./

# Set environment variables
ENV PORT=8080
ENV API_TARGET=http://backend:5000
ENV MGMT_TARGET=http://backend:5001

EXPOSE 8080
CMD ["node", "server.js"]
