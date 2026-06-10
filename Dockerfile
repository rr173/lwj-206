FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json ./
RUN npm install --production
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data
EXPOSE 3033
CMD ["node", "server/index.js"]
