# Multiplayer errors: cause and fix (backend port 8080, front-end e.g. 5500)

1. ERR_CONNECTION_REFUSED  -> backend not running, wrong port, or missing websocket dependency.
   Fix: add spring-boot-starter-websocket (backend/pom-add-this.xml), run `mvn spring-boot:run`,
   open http://localhost:8080/api/health. Front-end now defaults to http://localhost:8080 on localhost.
2. CORS blocked -> your front-end origin is not allowed.
   localhost on any port is already allowed. For other origins:
   KNIGHT_ALLOWED_ORIGINS=http://192.168.1.5:5500   (Windows: set ... ; Mac/Linux: export ...)
3. EADDRINUSE / "Port 8080 was already in use" -> old process still running.
   Mac/Linux: lsof -ti:8080 | xargs kill -9      Windows: netstat -ano | findstr :8080  then  taskkill /PID <pid> /F
   Or use another port: PORT=8081 mvn spring-boot:run (and set apiBase in config.js to match).
4. Transport close / ping timeout -> idle sockets were dropped. Client now pings every 25s,
   server answers "pong", and the client auto-reconnects every 4s.
5. Clients overriding each other -> server keys every connection by its own unique session id
   (not by user id), so two tabs/devices of one user never replace each other; presence is a
   set of user ids. The flood guard now applies to chat only, so join/ping are never dropped.
