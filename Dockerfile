# Build stage
FROM node:26-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install pnpm (corepack is no longer bundled with Node 25+)
RUN npm install -g pnpm@12.4.1

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source files
COPY . .

# Run tests
RUN pnpm test

# Build library and examples
RUN pnpm run build && pnpm run build:examples

# Production stage
FROM nginx:alpine

# Copy built examples to nginx (served under /web-geoagent/ to match Vite base path)
COPY --from=builder /app/dist-examples /usr/share/nginx/html/web-geoagent

# Copy custom nginx config
RUN echo 'server { \
    listen 80; \
    server_name localhost; \
    root /usr/share/nginx/html; \
    index index.html; \
    \
    location /web-geoagent/ { \
        try_files $uri $uri/ /web-geoagent/index.html; \
    } \
    \
    location = / { \
        return 302 /web-geoagent/; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

# Startup script that prints URL and starts nginx
RUN printf '#!/bin/sh\n\
echo ""\n\
echo "======================================================"\n\
echo "  web-geoagent Examples"\n\
echo "======================================================"\n\
echo ""\n\
echo "  Server running on port 80"\n\
echo ""\n\
echo "  If you ran: docker run -p 8080:80 ..."\n\
echo "  Open: http://localhost:8080/web-geoagent/"\n\
echo ""\n\
echo "======================================================"\n\
echo ""\n\
exec nginx -g "daemon off;"\n' > /start.sh && chmod +x /start.sh

CMD ["/start.sh"]
