FROM envoyproxy/envoy:v1.31.5@sha256:2ef22f7a72d3008d68bd4912f52b9a3d466d00db31a567dffa1b103e42eb9198 AS envoy

FROM node:24-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203
COPY --from=envoy /usr/local/bin/envoy /usr/local/bin/envoy

RUN apt-get update && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./
COPY deploy/egress-proxy/envoy.yaml deploy/egress-proxy/start.sh ./
RUN chmod +x start.sh

ENV NODE_ENV=production
EXPOSE 48080

CMD ["/app/start.sh"]
