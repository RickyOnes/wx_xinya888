FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y squid apache2-utils \
 && rm -rf /var/lib/apt/lists/*

# copy files from repository root 'proxy' context
# examples/squid.conf lives at proxy/examples/squid.conf
COPY examples/squid.conf /etc/squid/squid.conf
COPY squid/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3128
CMD ["/entrypoint.sh"]
