FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY config ./config
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY public ./public

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
