#!/bin/sh
# Starts the Docker daemon of the clean Linux and keeps the container alive.
dockerd --host=unix:///var/run/docker.sock >/var/log/dockerd.log 2>&1 &
exec sleep infinity
