# Test machine for the Bronto panel: behaves like a fresh Contabo Ubuntu 22.04
# VM. systemd is PID 1, Docker and sshd run as services, root logs in with an
# SSH key only. The panel's install script needs exactly this (Docker present,
# `systemctl enable fangs`).
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    container=docker

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server docker.io \
      curl ca-certificates iproute2 iptables sudo jq less vim-tiny && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Units that have no job in a container.
RUN systemctl mask \
      getty.target console-getty.service systemd-logind.service \
      systemd-udevd.service systemd-udev-trigger.service \
      systemd-remount-fs.service systemd-modules-load.service \
      sys-kernel-debug.mount sys-kernel-tracing.mount sys-kernel-config.mount \
      dev-hugepages.mount apt-daily.timer apt-daily-upgrade.timer \
      motd-news.timer e2scrub_reap.service

# Key-only root login. The simulator writes /root/.ssh/authorized_keys from
# the create request (cloud-config ssh_authorized_keys or sshKeys secrets).
RUN mkdir -p /root/.ssh && chmod 700 /root/.ssh && passwd -l root && \
    printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n' \
      > /etc/ssh/sshd_config.d/10-sim.conf

# Each machine gets its own host keys on first boot.
RUN rm -f /etc/ssh/ssh_host_* && \
    printf '%s\n' \
      '[Unit]' \
      'Description=Generate SSH host keys' \
      'Before=ssh.service' \
      'ConditionPathExists=!/etc/ssh/ssh_host_ed25519_key' \
      '[Service]' \
      'Type=oneshot' \
      'ExecStart=/usr/bin/ssh-keygen -A' \
      '[Install]' \
      'WantedBy=multi-user.target' \
      > /etc/systemd/system/ssh-hostkeys.service && \
    systemctl enable ssh-hostkeys.service ssh.service docker.service

VOLUME ["/var/lib/docker", "/var/lib/containerd"]
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
