FROM python:3.12-slim
WORKDIR /srv
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir '.[onnx]'
# Models download on first start into this volume; pin them with OPENPARK_MODEL_SHA256.
ENV HOME=/models
VOLUME /models
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request as u; u.urlopen('http://localhost:8000/healthz')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
