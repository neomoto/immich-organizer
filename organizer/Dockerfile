FROM node:22-bookworm-slim
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
