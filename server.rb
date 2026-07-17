# Static-only preview of the Sentinel DD frontend (public/).
# NOTE: this serves the UI but NOT the /api backend, so sign-in and all data
# calls will fail here. For the full app use the Cloudflare Worker instead:
#     npx wrangler dev          (local, serves public/ + the API)
#     npx wrangler deploy       (production)
# Run:  ruby server.rb   then open http://localhost:4599
require 'webrick'
root = File.join(__dir__, 'public')
server = WEBrick::HTTPServer.new(Port: 4599, DocumentRoot: root)
trap('INT') { server.shutdown }
puts "Sentinel DD (frontend only) at http://localhost:4599 — use 'npx wrangler dev' for the full app."
server.start
