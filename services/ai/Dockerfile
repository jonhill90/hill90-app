# Hill90 AI Service Dockerfile (Python/FastAPI)
# Multi-stage build for production

FROM python:3.12-slim as builder

WORKDIR /build

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY pyproject.toml poetry.lock ./

# Install Poetry and dependencies
RUN pip install --no-cache-dir poetry==1.8.5 && \
    poetry config virtualenvs.create false && \
    poetry install --only main --no-interaction --no-ansi

# Production stage
FROM python:3.12-slim

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application code
COPY app ./app

# Create non-root user
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request, sys; r=urllib.request.urlopen('http://localhost:8000/health'); sys.exit(0 if r.status < 400 else 1)"

CMD ["opentelemetry-instrument", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# What commit produced this image (app#561, the twin of #228/#558 for the
# services whose Dockerfiles never had this stamp). Defaults to `unstamped`
# rather than failing: a build that forgets the arg should still work and
# should SAY it is unknown, not claim a revision it does not have.
ARG GIT_REVISION=unstamped
LABEL com.hill90.revision=$GIT_REVISION
