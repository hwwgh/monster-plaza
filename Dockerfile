FROM node:20-alpine
WORKDIR /app
COPY monster-server.js package.json ./
EXPOSE 8420
ENV PORT=8420
CMD ["node", "monster-server.js"]
