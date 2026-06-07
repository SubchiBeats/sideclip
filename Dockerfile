FROM node:22-alpine
WORKDIR /app
COPY . .
ENV HOST=0.0.0.0 PORT=4173 NODE_ENV=production
EXPOSE 4173
VOLUME ["/app/data"]
RUN mkdir -p /app/data && chown -R node:node /app
USER node
CMD ["node", "server.js"]
