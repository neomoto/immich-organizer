# Application dependencies and native tools are unchanged from this exact base.
# Compile server/dist and web/build from the same commit before building this image.
FROM ghcr.io/immich-app/immich-server:v3.1.0@sha256:b434cb9287eea1471c9974845914d4dd328c9c2d652e446ed4930f99944f0ceb
COPY server/dist /usr/src/app/server/dist
COPY web/build /build/www
ARG SOURCE_COMMIT
ARG VERSION=0.1.0-alpha.3
LABEL org.opencontainers.image.source="https://github.com/neomoto/immich-organizer" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
ENV IMMICH_REPOSITORY=neomoto/immich-organizer \
    IMMICH_REPOSITORY_URL=https://github.com/neomoto/immich-organizer \
    IMMICH_SOURCE_COMMIT=${SOURCE_COMMIT} \
    IMMICH_SOURCE_URL=https://github.com/neomoto/immich-organizer/commit/${SOURCE_COMMIT}
