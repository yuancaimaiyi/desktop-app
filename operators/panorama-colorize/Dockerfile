FROM crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/glim-dense-cloud:0.2

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="panorama-colorize"
LABEL org.hera.operator.version="0.1"
LABEL org.hera.operator.manifest.path="/operator.json"

# OpenCV for bilinear sampling and JPEG decode
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libopencv-dev && \
    rm -rf /var/lib/apt/lists/*

COPY src/ /opt/build/src/

RUN . /opt/ros/humble/setup.sh && \
    cd /opt/build && mkdir -p build2 && cd build2 && \
    cmake ../src -DCMAKE_PREFIX_PATH=/opt/glim_offline && \
    make -j && \
    cp panorama_colorize /opt/scripts/

COPY colorize_entry.sh /opt/scripts/colorize_entry.sh
RUN chmod +x /opt/scripts/colorize_entry.sh

COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]
