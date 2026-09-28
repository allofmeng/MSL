# Receiver page + short-link store for QR-shared profiles.
#
# The profile still travels inside the fragment, which browsers never send to
# the server, so docs/share.html decodes it entirely client-side — that part
# is unchanged. server.js only adds a thin layer on top: POST the fragment
# once at /api/s, get a short id back, and GET /s/<id> 302s to /#<fragment> so
# a link is short enough to paste into a chat instead of only scannable. See
# server.js's header for what that store does and does not guarantee.
FROM node:20-alpine
WORKDIR /app
COPY server.js share.html ./
EXPOSE 80
CMD ["node", "server.js"]
