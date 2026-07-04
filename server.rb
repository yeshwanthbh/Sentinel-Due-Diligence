# Simple static server for Sentinel DD. Run:  ruby server.rb   then open http://localhost:4599
require 'webrick'
server = WEBrick::HTTPServer.new(Port: 4599, DocumentRoot: __dir__)
trap('INT') { server.shutdown }
puts "Sentinel DD running at http://localhost:4599"
server.start
