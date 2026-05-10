FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit
COPY . .
EXPOSE 3000
USER node
CMD ["node", "--no-deprecation", "server.js"]
