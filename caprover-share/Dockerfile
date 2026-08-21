# Receiver page for QR-shared profiles, as a static site.
#
# There is no backend by design: the profile travels inside the QR code, in the
# URL fragment, which browsers never send to the server. This image serves one
# HTML file that decodes it in the browser. Nothing is uploaded, nothing is
# stored, and there is no state to back up.
FROM nginx:alpine

# Served as index.html, not share.html, so links read
# https://share.example.com/#payload — eleven characters shorter than
# /share.html#payload, which is eleven fewer bytes of QR code.
COPY share.html /usr/share/nginx/html/index.html

# The decoder must never be stale: a cached old copy would fail to read links a
# newer sender produces. The file is a few KB, so revalidating every load costs
# nothing. Written at http level, where add_header is valid, so the stock
# default.conf server block is left alone.
RUN printf 'add_header Cache-Control "no-cache";\n' > /etc/nginx/conf.d/cache.conf \
    && nginx -t

EXPOSE 80
