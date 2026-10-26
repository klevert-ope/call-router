FROM debian:bookworm-slim
ARG ASTERISK_VERSION=22.8.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl ca-certificates pkg-config libedit-dev libxml2-dev \
    libsqlite3-dev uuid-dev libssl-dev libjansson-dev libsrtp2-dev \
    libncurses-dev libspeexdsp-dev bzip2 patch python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src
RUN curl -fsSL "https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz" -o asterisk.tar.gz \
    && tar -xzf asterisk.tar.gz && cd "asterisk-${ASTERISK_VERSION}" \
    && ./configure --libdir=/usr/lib --with-pjproject-bundled \
    && make menuselect.makeopts \
    && menuselect/menuselect --disable BUILD_NATIVE \
       --disable-category MENUSELECT_CORE_SOUNDS \
       --disable-category MENUSELECT_EXTRA_SOUNDS \
       --disable-category MENUSELECT_MOH menuselect.makeopts \
    && make -j2 && make install && ldconfig \
    && cd / && rm -rf /usr/src/asterisk*
RUN groupadd -g 10001 asterisk && useradd -r -u 10001 -g asterisk asterisk \
    && mkdir -p /var/run/asterisk /var/log/asterisk /var/spool/asterisk /var/lib/asterisk \
    && chown -R asterisk:asterisk /var/run/asterisk /var/log/asterisk /var/spool/asterisk /var/lib/asterisk
USER asterisk
WORKDIR /var/lib/asterisk
CMD ["/usr/sbin/asterisk", "-f"]
