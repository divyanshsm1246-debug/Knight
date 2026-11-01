# Multiplayer errors: cause and fix (backend port 8080)
1. ERR_CONNECTION_REFUSED -> backend not running / wrong port / websocket dependency missing. Add pom-add-this.xml, run `mvn spring-boot:run`, open http://localhost:8080/api/health.
2. CORS blocked -> localhost (any port) is allowed; for others set KNIGHT_ALLOWED_ORIGINS=http://192.168.1.5:5500
3. EADDRINUSE -> Mac/Linux: lsof -ti:8080 | xargs kill -9 ; Windows: netstat -ano | findstr :8080 then taskkill /PID <pid> /F ; or PORT=8081 mvn spring-boot:run
4. Transport close / ping timeout -> client pings every 25s and reconnects automatically.
5. Clients overriding each other -> connections keyed by session id, people by Account ID.
