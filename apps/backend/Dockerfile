FROM node:24-alpine
WORKDIR /app
COPY package.json package.json
COPY tsconfig.base.json tsconfig.base.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN npm install
COPY . .
RUN npm run build --workspace @patima/shared && npm run build --workspace @patima/backend
EXPOSE 4000
CMD ["npm", "run", "start", "--workspace", "@patima/backend"]
