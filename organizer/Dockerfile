FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ARG SOURCE_COMMIT
ARG VERSION=0.1.0-alpha.1
LABEL org.opencontainers.image.source="https://github.com/neomoto/immich-organizer" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libimage-exiftool-perl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY organizer/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY organizer/src ./src
USER node
ENV NODE_ENV=production
EXPOSE 8091
HEALTHCHECK --interval=30s CMD node -e "fetch('http://127.0.0.1:8091/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/server.mjs"]
