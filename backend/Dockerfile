FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PINQEVA_FINDMY_ANISETTE_PROVIDER=native \
    PINQEVA_FINDMY_ANISETTE_STATE_PATH=/var/lib/pinqeva/anisette-state.bin \
    PINQEVA_FINDMY_ANISETTE_URL=http://127.0.0.1:6970

WORKDIR /srv/pinqeva

COPY pyproject.toml README.md ./
COPY app ./app

RUN python -m pip install --upgrade pip \
    && python -m pip install . \
    && useradd --create-home --uid 10001 pinqeva \
    && mkdir -p /var/lib/pinqeva \
    && chown -R pinqeva:pinqeva /var/lib/pinqeva /srv/pinqeva

USER pinqeva
VOLUME ["/var/lib/pinqeva"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "from urllib.request import urlopen; urlopen('http://127.0.0.1:8080/health', timeout=3).read()"]

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
