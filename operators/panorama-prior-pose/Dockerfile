FROM python:3.11-slim

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="panorama-prior-pose"
LABEL org.hera.operator.version="0.1"
LABEL org.hera.operator.manifest.path="/operator.json"

# ffmpeg for frame extraction + python deps
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ffmpeg && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir numpy scipy -i https://mirrors.aliyun.com/pypi/simple/

RUN mkdir -p /opt/scripts

COPY panorama_to_prior_poses.py /opt/scripts/
COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]
