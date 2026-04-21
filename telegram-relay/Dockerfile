FROM node:20-slim

RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

CMD ["npm", "run", "start"]
