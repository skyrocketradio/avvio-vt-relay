# ===== Build =====
FROM swift:6.0-jammy AS build
WORKDIR /build
COPY ./Package.* ./
RUN swift package resolve --skip-update
COPY . .
RUN swift build -c release --static-swift-stdlib
RUN mkdir -p /staging \
 && cp "$(swift build -c release --show-bin-path)/AvvioVTRelay" /staging/ \
 && cp -r Public /staging/Public 2>/dev/null || mkdir -p /staging/Public

# ===== Run =====
FROM ubuntu:jammy
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata libcurl4 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /staging /app
ENV AVVIO_VT_DATA=/data
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["./AvvioVTRelay"]
CMD ["serve", "--env", "production", "--hostname", "0.0.0.0", "--port", "8080"]
