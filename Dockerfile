FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY claim-server.mjs common.mjs mine-rules.mjs rwa-receipt.mjs attest.mjs pov-tasks.mjs ./
COPY stake ./stake
ENV PORT=8080 MAINNET=1
EXPOSE 8080
CMD ["node", "claim-server.mjs"]
