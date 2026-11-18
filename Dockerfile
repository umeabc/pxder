FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node LICENSE /app/LICENSE
COPY --chown=node:node src/pixiv-api-config.js /app/src/pixiv-api-config.js
COPY --chown=node:node web/ /app/web/
RUN install -d -m 0700 -o node -g node /data \
    && install -d -m 0750 -o node -g node /downloads
USER node
ENV NODE_ENV=production PXDER_HOST=0.0.0.0 PXDER_PORT=8080 PXDER_DATA_DIR=/data PXDER_DOWNLOAD_DIR=/downloads
EXPOSE 8080
CMD ["node", "web/server.js"]
