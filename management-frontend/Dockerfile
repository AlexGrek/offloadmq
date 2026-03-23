# Runtime stage (frontend built locally and pre-built artifacts copied)
FROM node:24-slim
WORKDIR /app

# Install production dependencies for the server only
COPY server/package*.json ./
RUN npm install --omit=dev

# Copy pre-built frontend (built locally) and server
COPY dist ./dist
COPY server/server.js ./

# Set environment variables
ENV PORT=8080
ENV API_TARGET=http://backend:5000
ENV MGMT_TARGET=http://backend:5001

EXPOSE 8080
CMD ["node", "server.js"]
