FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app

COPY plugins/portal/package.json plugins/portal/package-lock.json ./
RUN npm ci --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache

COPY plugins/portal/src ./src
COPY plugins/chassis/src /chassis/src
COPY plugins/portal/tsconfig.json ./

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.ts"]
