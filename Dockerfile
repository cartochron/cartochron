# Leaflet is fetched and SHA-512-verified at build time, never at container startup.
FROM python:3.12-slim-bookworm AS assets
WORKDIR /build
COPY vendor_leaflet.py .
RUN python3 vendor_leaflet.py

FROM python:3.12-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=assets /build/vendor/leaflet ./vendor/leaflet
COPY map_server.py observation_store.py sources.py channels.py annotations.py index.html viewer.js manual.html ./
COPY docs/images/ ./docs/images/
# Numeric unprivileged default for direct docker run; Compose uses the host UID/GID
# so its private bind-mounted SQLite database can be backed up without chown.
USER 65532:65532
EXPOSE 8765
ENTRYPOINT ["python3", "map_server.py"]
