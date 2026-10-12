FROM crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/glim-runner:r0.22

LABEL org.hera.operator.spec="1"
LABEL org.hera.operator.id="glim-dense-cloud"
LABEL org.hera.operator.version="0.2"
LABEL org.hera.operator.manifest.path="/operator.json"

# PCL for VoxelGrid + I/O
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libpcl-dev build-essential cmake && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/scripts /opt/build
COPY src/ /opt/build/src/

# glim and dependencies live under /opt/glim_offline (incl. headers + .so).
RUN . /opt/ros/humble/setup.sh && \
    cd /opt/build && mkdir build && cd build && \
    cmake ../src -DCMAKE_PREFIX_PATH=/opt/glim_offline && \
    make -j && \
    cp build_dense_cloud /opt/scripts/

COPY operator_self_describe.json /operator.json
COPY entrypoint.sh /hera_entrypoint.sh
RUN chmod +x /hera_entrypoint.sh

ENTRYPOINT ["/hera_entrypoint.sh"]
