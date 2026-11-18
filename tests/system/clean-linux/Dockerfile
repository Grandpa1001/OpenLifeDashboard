# A clean Ubuntu with its own Docker daemon, as a user's server has it (DEV D58.4): the packages of the
# distribution only (docker.io and docker-compose-v2), a user that is not root and belongs to the docker group.
# The test starts it privileged, so the daemon inside has its own images and containers.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io docker-compose-v2 ca-certificates curl python3 iproute2 iptables \
 && rm -rf /var/lib/apt/lists/*
# A registry without a port in its name, as a real one has (the manifest of a package names `name@sha256:...`):
# the daemon reaches `registry.test` over plain HTTP on port 80.
RUN mkdir -p /etc/docker && printf '{"insecure-registries":["registry.test"]}\n' > /etc/docker/daemon.json
RUN useradd --create-home --shell /bin/bash --groups docker tester
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
