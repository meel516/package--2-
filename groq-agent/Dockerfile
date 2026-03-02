FROM public.ecr.aws/lambda/nodejs:20 AS build

WORKDIR /var/task

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --omit=dev

FROM public.ecr.aws/lambda/nodejs:20

WORKDIR /var/task

COPY --from=build /var/task/package.json ./package.json
COPY --from=build /var/task/package-lock.json ./package-lock.json
COPY --from=build /var/task/node_modules ./node_modules
COPY --from=build /var/task/dist ./dist

CMD ["dist/index.handler"]
