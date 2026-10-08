# Public marketing site: static files served by nginx.
# Dokploy: new Application → this repo, build path "website", port 80.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY *.html /usr/share/nginx/html/
COPY *.png /usr/share/nginx/html/
COPY sectores/ /usr/share/nginx/html/sectores/
COPY img/ /usr/share/nginx/html/img/
