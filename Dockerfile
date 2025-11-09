FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
# replace this:
# RUN npm ci --omit=dev
# with this:
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 8080
CMD ["npm", "start"]
