FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install SSH, Docker daemon + CLI, and utilities
RUN apt-get update && \
    apt-get install -y \
      openssh-server sudo curl wget net-tools iputils-ping vim \
      docker.io jq ca-certificates iptables && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir /var/run/sshd

# Allow root login with password
RUN sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config

# Set default root password (will be overridden at container creation)
RUN echo 'root:Sim-Pass-123!' | chpasswd

# Entrypoint script: starts dockerd in background, then sshd in foreground
RUN echo '#!/bin/bash\n\
# Start Docker daemon in background (DinD)\n\
dockerd --host=unix:///var/run/docker.sock \
        --storage-driver=overlay2 \
        --iptables=false \
        > /var/log/dockerd.log 2>&1 &\n\
\n\
# Wait for Docker daemon to be ready\n\
for i in $(seq 1 30); do\n\
  docker info > /dev/null 2>&1 && break\n\
  sleep 1\n\
done\n\
\n\
echo "Docker daemon ready"\n\
\n\
# Start SSH in foreground\n\
exec /usr/sbin/sshd -D\n\
' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 22

CMD ["/usr/local/bin/entrypoint.sh"]
