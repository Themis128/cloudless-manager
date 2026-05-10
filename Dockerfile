FROM node:22-alpine
LABEL org.opencontainers.image.source=https://github.com/Themis128/cloudless-manager
LABEL org.opencontainers.image.description="Cloudless Manager — k3s/Cloudflare/AWS dashboard (training project)"
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit
COPY . .
EXPOSE 3000
USER node
CMD ["node", "--no-deprecation", "server.js"]
