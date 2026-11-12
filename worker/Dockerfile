FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    RVC_PROJECT_ROOT=/opt/rvc \
    TEMP_ROOT=/tmp/hendy-ai-cover

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg git git-lfs build-essential libsndfile1 libgomp1 libportaudio2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# RVC's current upstream branch targets Python 3.12. The CPU dependency set
# pins a compatible CPU-only Torch/Torchaudio pair for Linux workers.
# Pin the RVC source used by this build so the inference CLI cannot drift silently.
ARG RVC_COMMIT=81eed5e8f68b6bed1789f682fe78cdd324495afc
RUN git init /opt/rvc \
    && git -C /opt/rvc remote add origin https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI.git \
    && git -C /opt/rvc fetch --depth 1 origin "$RVC_COMMIT" \
    && git -C /opt/rvc checkout --detach FETCH_HEAD
RUN pip install --no-cache-dir -r /opt/rvc/requirments_cpu_py312.txt

# Required RVC inference feature/pitch assets; voice-specific .pth/.index
# files are not bundled and are fetched from the private R2 bucket at runtime.
RUN pip install --no-cache-dir huggingface_hub \
    && cd /opt/rvc \
    && hf download lj1995/VoiceConversionWebUI --revision main --include "hubert_base/*" --local-dir assets \
    && hf download lj1995/VoiceConversionWebUI rmvpe.pt --revision main --local-dir assets/rmvpe

WORKDIR /app
COPY worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY worker/core.py /app/core.py
COPY worker/worker.py /app/worker.py
COPY config/voices.json /app/config/voices.json
RUN useradd --create-home --uid 10001 coverworker \
    && mkdir -p /tmp/hendy-ai-cover \
    && chown -R coverworker:coverworker /app /opt/rvc /tmp/hendy-ai-cover
USER coverworker

CMD ["python", "/app/worker.py"]
