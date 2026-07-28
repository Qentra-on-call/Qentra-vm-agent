FROM node:20-alpine
WORKDIR /app
COPY index.js ./
# Needs `df` (coreutils, already in alpine base) — no npm deps at all.
CMD ["node", "index.js"]
